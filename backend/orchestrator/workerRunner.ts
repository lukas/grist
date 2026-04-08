import { getTask, updateTask, touchTaskActivity } from "../db/taskRepo.js";
import { getJob, addJobTokenUsage } from "../db/jobRepo.js";
import { insertEvent, listEventsByTaskId } from "../db/eventRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { WorkerDecisionSchema } from "../types/taskState.js";
import { executeTool } from "../tools/executeTool.js";
import type { ToolContext } from "../tools/toolTypes.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import { runReducerPass } from "./reducer.js";
import { runVerifierPass } from "./verifier.js";
import { appendTaskLog } from "../logging/taskLogger.js";

const RECENT_WINDOW = 10;
const MASKED_MAX_CHARS = 200;

function compactHistory(history: { role: string; content: string }[]): { role: string; content: string }[] {
  if (history.length <= RECENT_WINDOW) return history;
  const cutoff = history.length - RECENT_WINDOW;
  return history.map((h, i) => {
    if (i >= cutoff) return h;
    // Keep assistant reasoning and user messages intact; mask verbose tool results
    if (h.role === "tool_result") {
      if (h.content.length <= MASKED_MAX_CHARS) return h;
      return { role: h.role, content: h.content.slice(0, MASKED_MAX_CHARS) + " … [truncated]" };
    }
    return h;
  });
}

function buildToolContext(
  task: NonNullable<ReturnType<typeof getTask>>,
  jobRepoPath: string,
  appWorkspaceRoot: string,
  commandAllowlist: string[],
  emit: ToolContext["emit"]
): ToolContext {
  const t = task;
  const allowed = JSON.parse(t.allowed_tools_json) as string[];
  // If task allows writes but has no worktree yet, write directly to the repo
  const worktree = t.worktree_path || (t.write_mode !== "none" ? jobRepoPath : null);
  return {
    jobId: t.job_id,
    taskId: t.id,
    repoPath: jobRepoPath,
    worktreePath: worktree,
    scratchpadPath: t.scratchpad_path,
    appWorkspaceRoot,
    allowedToolNames: allowed,
    commandAllowlist,
    emit,
  };
}

function mergeJsonArray(existing: string, additions: unknown[] | undefined): string {
  if (!additions?.length) return existing;
  const cur = JSON.parse(existing || "[]") as unknown[];
  return JSON.stringify([...cur, ...additions]);
}

export async function runTaskWorker(
  taskId: number,
  signal: AbortSignal,
  appWorkspaceRoot: string,
  onDuplicateHint?: (msg: string) => void,
  onBroadcast?: (kind: string, jobId: number, taskId: number, data?: unknown) => void
): Promise<void> {
  const row = getTask(taskId);
  if (!row) return;
  const job = getJob(row.job_id);
  if (!job) return;

  if (row.kind === "reducer") {
    await runReducerPass(row);
    return;
  }

  if (row.kind === "verifier") {
    const settings = loadAppSettings();
    const ctx = buildToolContext(
      row,
      job.repo_path,
      appWorkspaceRoot,
      settings.commandAllowlist || [],
      (level, type, message, data) => {
        insertEvent({
          job_id: row.job_id,
          task_id: row.id,
          level,
          type,
          message,
          data_json: data != null ? JSON.stringify(data) : null,
        });
      }
    );
    await runVerifierPass(row, {}, ctx, signal);
    return;
  }

  const settings = loadAppSettings();
  const provider = createProvider(row.assigned_model_provider, settings);
  const repoPath = job.repo_path;

  const log = (entry: Omit<Parameters<typeof appendTaskLog>[1], "jobId" | "taskId">) =>
    appendTaskLog(repoPath, { ...entry, jobId: row.job_id, taskId });

  ensureScratchpad(row.scratchpad_path);
  const signatures: string[] = [];
  const history: { role: string; content: string }[] = [];
  const seenUserMsgIds = new Set<number>();
  let consecutiveEmpty = 0;
  let consecutiveErrors = 0;

  const emit = (level: "info" | "warn" | "error", type: string, message: string, data?: unknown) => {
    insertEvent({
      job_id: row.job_id,
      task_id: row.id,
      level,
      type,
      message,
      data_json: data != null ? JSON.stringify(data) : null,
    });
    if (level === "warn" && type === "auto_pause") {
      onBroadcast?.(type, row.job_id, row.id, data);
    }
  };

  while (!signal.aborted) {
    const task = getTask(taskId);
    if (!task) break;
    const jobRow = getJob(task.job_id);
    if (jobRow?.status === "paused") {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (task.status === "stopped" || task.status === "done" || task.status === "failed") break;
    if (task.status === "paused") {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (task.status !== "running") break;

    if (task.steps_used >= task.max_steps) {
      updateTask(taskId, { status: "paused", blocker: `max_steps exceeded (${task.steps_used}/${task.max_steps})`, next_action: "operator" });
      emit("warn", "budget", `max_steps exceeded — ${task.steps_used}/${task.max_steps} steps used, model: ${row.assigned_model_provider}`, { steps: task.steps_used, max_steps: task.max_steps, model: row.assigned_model_provider });
      break;
    }
    if (task.tokens_used >= task.max_tokens) {
      updateTask(taskId, { status: "paused", blocker: `max_tokens exceeded (${task.tokens_used.toLocaleString()}/${task.max_tokens.toLocaleString()} tokens, model: ${row.assigned_model_provider})` });
      emit("warn", "budget", `max_tokens exceeded — ${task.tokens_used.toLocaleString()}/${task.max_tokens.toLocaleString()} tokens, model: ${row.assigned_model_provider}, history: ${history.length} entries`, { tokens: task.tokens_used, max_tokens: task.max_tokens, model: row.assigned_model_provider, history_len: history.length });
      break;
    }

    // Inject any user messages added since last step
    const allEvts = listEventsByTaskId(taskId, 500) as { id: number; type: string; message: string }[];
    const userMsgs = allEvts
      .filter((e) => e.type === "user_message" && !seenUserMsgIds.has(e.id))
      .slice(-5);
    for (const um of userMsgs) {
      seenUserMsgIds.add(um.id);
      history.push({ role: "user", content: `[Operator message]: ${um.message}` });
    }

    const stepNum = task.steps_used + 1;
    const allowed = JSON.parse(task.allowed_tools_json) as string[];
    const canWrite = allowed.includes("write_file");
    const sys = `You are a Grist coding agent. Task role: ${task.role}. Step ${stepNum} of max ${task.max_steps}.
OPTIMIZE FOR SPEED: minimize wall-clock time by running independent tools in parallel.

Allowed tools: ${allowed.join(", ")}
${canWrite ? `Tool reference:
- write_file: {"path": "relative/path.ext", "content": "full file content"} — creates or overwrites a file
- list_files: {"path": ".", "recursive": true} — list files in directory
- read_file: {"path": "relative/path.ext"} — read a file
- grep_code: {"pattern": "regex"} — search code
- run_command_safe: {"command": "npm install"} — run a shell command
` : ""}
Respond with JSON. You have two options:

1) Single tool: {"decision":"call_tool", "reasoning_summary":"...", "tool_name":"...", "tool_args":{...}}
2) Parallel tools (PREFERRED when independent): {"decision":"call_tools", "reasoning_summary":"...", "tool_calls":[{"tool_name":"...", "tool_args":{...}}, ...]}

Use call_tools to run independent operations in parallel — e.g. reading multiple files, writing independent files, or running grep while listing files. This cuts wall-clock time.

IMPORTANT:
- Do NOT read_file a file you just wrote — you already know its contents.
- Do NOT parallelize tools that depend on each other (e.g. read then write based on read).
- When done, use {"decision":"finish", "reasoning_summary":"what was accomplished"}.`;

    const compacted = compactHistory(history);
    const historyBlock = compacted.length
      ? "\n\nPrevious steps:\n" + compacted.map((h) => `[${h.role}]: ${h.content}`).join("\n")
      : "";

    const user = `Job goal: ${job.user_goal}
Operator notes: ${job.operator_notes || ""}
Task goal: ${task.goal}
Scope: ${task.scope_json}
Current action: ${task.current_action}
Findings so far: ${task.findings_json}
Open questions: ${task.open_questions_json}${historyBlock}`;

    emit("info", "prompt", `step ${stepNum}`, { system: sys, user, step: stepNum });
    log({ timestamp: new Date().toISOString(), step: stepNum, type: "prompt", data: { system: sys, user } });

    const MAX_RETRIES = 3;
    let resp;
    updateTask(taskId, { current_action: "thinking" });
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        touchTaskActivity(taskId);
        resp = await provider.generateStructured({
          systemPrompt: sys,
          userPrompt: user,
          maxTokens: canWrite ? 16384 : 4096,
          temperature: 0.2,
        });
        break;
      } catch (e) {
        const isLastAttempt = attempt === MAX_RETRIES;
        emit(
          isLastAttempt ? "error" : "warn",
          "model_error",
          `${String(e)} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "error", data: { error: String(e), attempt } });
        if (isLastAttempt) {
          updateTask(taskId, { status: "failed", blocker: String(e) });
        } else {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          touchTaskActivity(taskId);
        }
      }
    }
    if (!resp) break;
    updateTask(taskId, { current_action: `step ${stepNum}` });

    addJobTokenUsage(task.job_id, resp.tokensIn + resp.tokensOut, resp.estimatedCost);
    const tokens = task.tokens_used + resp.tokensIn + resp.tokensOut;
    updateTask(taskId, {
      tokens_used: tokens,
      steps_used: stepNum,
    });
    touchTaskActivity(taskId);

    let decision;
    try {
      let raw =
        resp.parsedJson ??
        (() => {
          try {
            return JSON.parse(resp.text) as unknown;
          } catch {
            return null;
          }
        })();

      // Recovery: if JSON parse failed and response was truncated, retry with more tokens
      if (raw == null && resp.finishReason === "length") {
        const baseMax = canWrite ? 16384 : 4096;
        const doubledMax = baseMax * 2;
        if (resp.tokensOut >= baseMax * 0.9) {
          emit("warn", "truncated_retry", `Response truncated at ${resp.tokensOut} tokens, retrying with ${doubledMax}`);
          touchTaskActivity(taskId);
          try {
            const retryResp = await provider.generateStructured({
              systemPrompt: sys,
              userPrompt: user,
              maxTokens: doubledMax,
              temperature: 0.2,
            });
            addJobTokenUsage(task.job_id, retryResp.tokensIn + retryResp.tokensOut, retryResp.estimatedCost);
            touchTaskActivity(taskId);
            const retryParsed = retryResp.parsedJson ?? (() => { try { return JSON.parse(retryResp.text) as unknown; } catch { return null; } })();
            if (retryParsed != null) {
              raw = retryParsed;
              resp = retryResp;
            }
          } catch { /* fall through to partial recovery */ }
        }
      }
      if (raw == null && resp.finishReason === "length") {
        const toolMatch = resp.text.match(/"tool_name"\s*:\s*"(\w+)"/);
        if (toolMatch) {
          emit("warn", "truncated_response", `Response truncated (${resp.tokensOut} tokens). Extracting tool call from partial output.`);
          const recovered: Record<string, unknown> = {
            decision: "call_tool",
            reasoning_summary: "Response was truncated — extracted tool name from partial output",
            tool_name: toolMatch[1],
            tool_args: {},
          };
          // Try to extract tool_args JSON even if incomplete
          const argsMatch = resp.text.match(/"tool_args"\s*:\s*(\{[\s\S]*)/);
          if (argsMatch) {
            const argsStr = argsMatch[1];
            for (let i = argsStr.length; i > 0; i--) {
              try {
                const candidate = argsStr.slice(0, i);
                const opens = (candidate.match(/\{/g) || []).length;
                const closes = (candidate.match(/\}/g) || []).length;
                const fixed = candidate + "}".repeat(Math.max(0, opens - closes));
                recovered.tool_args = JSON.parse(fixed);
                break;
              } catch { continue; }
            }
          }
          raw = recovered;
        }
      }

      if (raw == null) throw new Error("empty decision");
      const obj = raw as Record<string, unknown>;
      if (obj.tool && !obj.tool_name) obj.tool_name = obj.tool;
      if (obj.args && !obj.tool_args) obj.tool_args = obj.args;
      if (obj.reasoning && !obj.reasoning_summary) obj.reasoning_summary = obj.reasoning;
      decision = WorkerDecisionSchema.parse(obj);
    } catch (e) {
      consecutiveErrors++;
      emit("warn", "parse_error", `${String(e)} (${consecutiveErrors}/3 consecutive)`, { raw: resp.text.slice(0, 2000) });
      log({ timestamp: new Date().toISOString(), step: stepNum, type: "error", data: { parse_error: String(e), raw: resp.text.slice(0, 4000) } });
      if (consecutiveErrors >= 3) {
        updateTask(taskId, { status: "failed", blocker: "invalid model JSON (3 consecutive parse errors)" });
        break;
      }
      history.push({ role: "tool_result", content: `[system] Your previous response was not valid JSON. Please respond with a valid JSON object.` });
      continue;
    }

    emit("info", "model_response", `step ${stepNum}: ${decision.decision}`, {
      reasoning: decision.reasoning_summary,
      decision: decision.decision,
      tool_name: decision.tool_name,
      tool_args: decision.tool_args,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
      raw: resp.text.slice(0, 4000),
      step: stepNum,
    });
    log({ timestamp: new Date().toISOString(), step: stepNum, type: "response", data: {
      reasoning: decision.reasoning_summary,
      decision: decision.decision,
      tool_name: decision.tool_name,
      tool_args: decision.tool_args,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
      raw: resp.text,
    }});

    // Normalize call_tools with single entry to call_tool
    if (decision.decision === "call_tools" && decision.tool_calls?.length === 1) {
      decision = { ...decision, decision: "call_tool", tool_name: decision.tool_calls[0].tool_name, tool_args: decision.tool_calls[0].tool_args };
    }
    // Normalize call_tool into a uniform tool_calls array for processing
    const toolCalls: { tool_name: string; tool_args: Record<string, unknown> }[] =
      decision.decision === "call_tools" && decision.tool_calls
        ? decision.tool_calls.map((tc) => ({ tool_name: tc.tool_name, tool_args: (tc.tool_args || {}) as Record<string, unknown> }))
        : decision.decision === "call_tool"
          ? [{ tool_name: decision.tool_name || "", tool_args: (decision.tool_args || {}) as Record<string, unknown> }]
          : [];

    history.push({ role: "assistant", content: JSON.stringify({
      decision: decision.decision,
      tool_name: decision.tool_name,
      tool_calls: toolCalls.length > 1 ? toolCalls.map((tc) => tc.tool_name) : undefined,
      reasoning: decision.reasoning_summary,
    }) });

    const tsu = decision.task_state_update;
    if (tsu) {
      updateTask(taskId, {
        current_action: tsu.current_action ?? task.current_action,
        next_action: tsu.next_action ?? task.next_action,
        confidence: tsu.confidence ?? task.confidence,
        findings_json: mergeJsonArray(task.findings_json, tsu.new_findings as unknown[] | undefined),
        open_questions_json: mergeJsonArray(task.open_questions_json, tsu.new_open_questions as unknown[] | undefined),
      });
    }

    if (decision.decision === "finish") {
      const cur = getTask(taskId);
      if (!cur) break;
      const art = decision.artifact;
      if (art) {
        insertArtifact({
          job_id: cur.job_id,
          task_id: cur.id,
          type: art.type,
          content_json: JSON.stringify(art.content),
          confidence: tsu?.confidence ?? 0.7,
        });
      }
      updateTask(taskId, { status: "done", current_action: "finished", next_action: "" });
      emit("info", "task_done", decision.reasoning_summary || "done");
      break;
    }

    if (decision.decision === "pause_self") {
      updateTask(taskId, { status: "paused", blocker: decision.reasoning_summary || "pause" });
      emit("info", "pause_self", decision.reasoning_summary);
      break;
    }

    if (decision.decision === "call_tool" || decision.decision === "call_tools") {
      // Detect repeated identical calls (3x) — auto-pause
      for (const tc of toolCalls) {
        const sig = `${tc.tool_name}:${JSON.stringify(tc.tool_args)}`;
        signatures.push(sig);
      }
      if (signatures.length >= 3) {
        const last3 = signatures.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          onDuplicateHint?.("Repeated identical tool pattern x3");
          emit("warn", "auto_pause", "Repeated identical tool call 3x — auto-pausing", { sig: last3[0] });
          log({ timestamp: new Date().toISOString(), step: stepNum, type: "auto_pause", data: { reason: "repeated_tool_call", sig: last3[0] } });
          updateTask(taskId, { status: "paused", blocker: `Auto-paused: repeated identical call 3x` });
          break;
        }
      }

      // Track empty tool names
      const hasEmpty = toolCalls.some((tc) => !tc.tool_name);
      if (hasEmpty) consecutiveEmpty++;
      else consecutiveEmpty = 0;
      if (consecutiveEmpty >= 3) {
        emit("warn", "auto_pause", "3 steps with no valid tool — auto-pausing", { consecutiveEmpty });
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "auto_pause", data: { reason: "no_tool_name", count: consecutiveEmpty } });
        updateTask(taskId, { status: "paused", blocker: "Auto-paused: model not producing valid tool calls" });
        break;
      }

      // Log all tool calls
      for (const tc of toolCalls) {
        emit("info", "tool_call", `${tc.tool_name}`, { tool_name: tc.tool_name, tool_args: tc.tool_args, step: stepNum });
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "tool_call", data: { tool_name: tc.tool_name, tool_args: tc.tool_args } });
      }

      // Execute tools — parallel when multiple, sequential when single
      const tr = getTask(taskId);
      if (!tr) break;
      const ctx = buildToolContext(tr, job.repo_path, appWorkspaceRoot, settings.commandAllowlist || [], emit);

      const results = toolCalls.length > 1
        ? await Promise.all(toolCalls.map((tc) => executeTool(tc.tool_name, tc.tool_args, ctx, signal)))
        : [await executeTool(toolCalls[0].tool_name, toolCalls[0].tool_args, ctx, signal)];

      // Process results
      let anyError = false;
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const result = results[i];
        const resultStr = JSON.stringify(result);
        const resultSnippet = resultStr.slice(0, 4000);
        const resultOk = typeof result === "object" && result !== null && (result as Record<string, unknown>).ok === true;

        if (!resultOk) anyError = true;

        emit("info", "tool_result", `${tc.tool_name} → ${resultSnippet.slice(0, 200)}`, { tool_name: tc.tool_name, result: resultSnippet, step: stepNum });
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "tool_result", data: { tool_name: tc.tool_name, result } });

        if (tc.tool_name === "write_file" || tc.tool_name === "apply_patch") {
          const ok = (result as Record<string, unknown>).ok;
          history.push({ role: "tool_result", content: `${tc.tool_name}: ${ok ? "success" : "failed"} — ${JSON.stringify((result as Record<string, unknown>).data || (result as Record<string, unknown>).error).slice(0, 200)}` });
        } else {
          history.push({ role: "tool_result", content: `${tc.tool_name} returned: ${resultSnippet.slice(0, 3000)}` });
        }

        // Track files examined
        if (tc.tool_name === "read_file" && typeof tc.tool_args.path === "string") {
          const fresh = getTask(taskId)!;
          const files = JSON.parse(fresh.files_examined_json || "[]") as string[];
          if (!files.includes(tc.tool_args.path as string)) {
            files.push(tc.tool_args.path as string);
            updateTask(taskId, { files_examined_json: JSON.stringify(files) });
          }
        }
      }

      touchTaskActivity(taskId);

      if (anyError) consecutiveErrors++;
      else consecutiveErrors = 0;
      if (consecutiveErrors >= 5) {
        emit("warn", "auto_pause", "5 consecutive tool errors — auto-pausing", { consecutiveErrors });
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "auto_pause", data: { reason: "consecutive_errors", count: consecutiveErrors } });
        updateTask(taskId, { status: "paused", blocker: `Auto-paused: ${consecutiveErrors} consecutive tool errors` });
        break;
      }
    }
  }
}
