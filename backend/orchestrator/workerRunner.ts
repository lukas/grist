import { getTask, updateTask, touchTaskActivity } from "../db/taskRepo.js";
import { getJob, addJobTokenUsage } from "../db/jobRepo.js";
import { insertEvent, listEventsByTaskId } from "../db/eventRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import {
  WorkerDecisionSchema,
  WorkerPacketSchema,
  defaultArtifactContentForRole,
  expectedArtifactTypeForRole,
} from "../types/taskState.js";
import { WORKER_ROLES, type WorkerRole } from "../types/models.js";
import { executeTool } from "../tools/executeTool.js";
import type { ToolContext } from "../tools/toolTypes.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import { runReducerPass } from "./reducer.js";
import { runVerifierPass } from "./verifier.js";
import { appendTaskLog } from "../logging/taskLogger.js";
import { execSync } from "node:child_process";
import { ensureHomeMemory, ensureRepoMemory, collectMemoryContext } from "../memory/memoryManager.js";
import { runReflection } from "./reflection.js";
import { buildSkillIndex } from "../skills/skillManager.js";
import { parseTaskRuntime } from "../runtime/taskRuntime.js";
import {
  normalizeWorkerDecisionCandidate,
  tryParseModelJson,
  WORKER_DECISION_JSON_SCHEMA,
} from "./workerDecisionUtils.js";

/* ─── Three-tier context compaction (inspired by Claude Code + OpenHands) ─── */

type HistoryEntry = { role: string; content: string };

const RECENT_WINDOW = 10;
const MASKED_MAX_CHARS = 200;
const CHARS_PER_TOKEN = 3.5;
const SUMMARIZE_THRESHOLD_ENTRIES = 30;
const MAX_CONTEXT_CHARS = 120_000;

const SUMMARIZE_PROMPT = `You are a context compaction agent. Summarize the following conversation history between a coding agent and its tools into a concise summary that preserves:
1. Key decisions and reasoning
2. Files created, modified, or examined (with paths)
3. Important findings and errors encountered
4. Current state and progress toward the goal
5. Any user/operator instructions

Be specific about file paths and code changes. Omit raw file contents and verbose tool output.
Output ONLY the summary text, no JSON wrapping.`;

function estimateTokens(entries: HistoryEntry[]): number {
  let chars = 0;
  for (const e of entries) chars += e.content.length + e.role.length + 4;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Tier 1: Observation masking — truncate verbose tool results outside the
 * recent window. Keeps assistant reasoning and user messages intact.
 * This is always applied and costs zero extra tokens.
 */
function maskObservations(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= RECENT_WINDOW) return history;
  const cutoff = history.length - RECENT_WINDOW;
  return history.map((h, i) => {
    if (i >= cutoff) return h;
    if (h.role === "tool_result") {
      if (h.content.length <= MASKED_MAX_CHARS) return h;
      const toolName = h.content.match(/^(\w+)/)?.[1] || "tool";
      const preview = h.content.slice(0, MASKED_MAX_CHARS).replace(/\n/g, " ");
      return { role: h.role, content: `[${toolName} output truncated] ${preview}…` };
    }
    return h;
  });
}

/**
 * Tier 2: LLM-based summarization — when the history is large, summarize
 * everything before the recent window into a single summary entry.
 * The summary replaces older entries, drastically reducing token count.
 * Uses the same provider as the task's model.
 */
async function summarizeOldHistory(
  oldEntries: HistoryEntry[],
  provider: import("../types/models.js").ModelProvider,
): Promise<string> {
  const text = oldEntries
    .map((h) => `[${h.role}]: ${h.content.slice(0, 1000)}`)
    .join("\n");
  const resp = await provider.generateText({
    systemPrompt: SUMMARIZE_PROMPT,
    userPrompt: text.slice(0, 50_000),
    maxTokens: 2048,
    temperature: 0.1,
  });
  return resp.text || "(compaction failed)";
}

/**
 * Full compaction pipeline:
 *   1. Always apply observation masking (free, no LLM call)
 *   2. If history is large enough AND estimated tokens exceed budget,
 *      summarize old entries via LLM
 *   3. Return the compacted history
 */
async function compactHistory(
  history: HistoryEntry[],
  provider: import("../types/models.js").ModelProvider,
  emit: (level: "info" | "warn" | "error", type: string, message: string, data?: unknown) => void,
): Promise<HistoryEntry[]> {
  // Tier 1: observation masking (always)
  let result = maskObservations(history);

  const estTokens = estimateTokens(result);
  const estChars = result.reduce((s, h) => s + h.content.length, 0);

  // Tier 2+3: LLM summarization when both entry count AND token budget warrant it
  if (result.length > SUMMARIZE_THRESHOLD_ENTRIES && estChars > MAX_CONTEXT_CHARS) {
    const keepRecent = result.slice(-RECENT_WINDOW);
    const oldEntries = result.slice(0, result.length - RECENT_WINDOW);

    try {
      emit("info", "compaction", `Summarizing ${oldEntries.length} old entries (est. ${estTokens} tokens)`, {
        old_entries: oldEntries.length,
        recent_entries: keepRecent.length,
        est_tokens: estTokens,
      });

      const summary = await summarizeOldHistory(oldEntries, provider);

      result = [
        { role: "system", content: `[Context summary of ${oldEntries.length} previous steps]\n${summary}` },
        ...keepRecent,
      ];

      emit("info", "compaction", `Compacted ${oldEntries.length} entries → summary (${summary.length} chars)`, {
        summary_chars: summary.length,
        new_total: result.length,
        saved_entries: oldEntries.length - 1,
      });
    } catch (e) {
      emit("warn", "compaction", `LLM summarization failed, falling back to masking: ${String(e)}`);
    }
  }

  return result;
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
  const scope = safeParseScope(t.scope_json);
  const worktree = t.worktree_path || (t.write_mode !== "none" && t.workspace_repo_mode !== "isolated_worktree" ? jobRepoPath : null);
  const runtime = parseTaskRuntime(t.runtime_json);
  return {
    jobId: t.job_id,
    taskId: t.id,
    repoPath: jobRepoPath,
    worktreePath: worktree,
    scopeFiles: scope.files,
    scratchpadPath: t.scratchpad_path,
    appWorkspaceRoot,
    allowedToolNames: allowed,
    commandAllowlist,
    commandEnv: runtime.hostPorts.http ? { GRIST_HOST_PORT: String(runtime.hostPorts.http) } : undefined,
    runtime,
    emit,
  };
}

function mergeJsonArray(existing: string, additions: unknown[] | undefined): string {
  if (!additions?.length) return existing;
  const cur = JSON.parse(existing || "[]") as unknown[];
  return JSON.stringify([...cur, ...additions]);
}

function safeParseScope(scopeJson: string): { files?: string[] } {
  try {
    const parsed = JSON.parse(scopeJson || "{}") as Record<string, unknown>;
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === "string" && f.trim() !== "")
      : undefined;
    return files?.length ? { files } : {};
  } catch {
    return {};
  }
}

function safeParsePacket(scopeJson: string): import("../types/taskState.js").WorkerPacket {
  try {
    return WorkerPacketSchema.parse(JSON.parse(scopeJson || "{}"));
  } catch {
    return WorkerPacketSchema.parse({});
  }
}

function isWorkerRole(role: string): role is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(role);
}

function describeRoleContract(role: WorkerRole): string {
  switch (role) {
    case "scout":
      return `Role contract:
- Scout only. Do repo reconnaissance and analogous-pattern discovery.
- Prefer list_files, grep_code, read_file, read_git_history, read_artifacts, and safe commands.
- Finish with artifact type "findings_report" containing: relevant_files, analogous_patterns, commands_to_run, ambiguity_notes.`;
    case "implementer":
      return `Role contract:
- Implementer only. Write code in your isolated worktree and stay inside packet.files when provided.
- If the repo is greenfield or your scope is broad, prefer one coherent runnable slice over multiple partial branches.
- Do not assume sibling implementer branches will be merged into your worktree automatically; recreate anything you need yourself.
- If shared scaffold/config/entrypoint work is missing and you are allowed to write it, create that runnable foundation before polishing leaf modules.
- Use run_command_safe / run_tests for validation. Do not manage Docker manually unless the task is explicitly about creating container setup files.
- If Grist already attached a runtime, do not prepend commands with \`cd /workspace &&\`; use the normal repo cwd and let Grist map it into the runtime.
- Prefer Grist repo tools ("list_files", "read_file", "grep_code") over shell probes like "pwd", "ls", or version checks unless the shell output itself is the thing you need.
- In a new Node/TypeScript repo, install dependencies before running build/typecheck commands so you do not waste steps on missing local binaries like \`tsc\`.
- Read existing artifacts first when useful, then implement, then run focused validation commands when possible.
- Finish with artifact type "candidate_patch" containing: diff_summary, files_changed, tests_added, migration_notes.`;
    case "reviewer":
      return `Role contract:
- Reviewer only. Do read-only regression/style/API review.
- Prefer read_artifacts, read_file, grep_code, and focused safe commands.
- Finish with artifact type "review_report" containing: findings, risk_flags, api_consistency_notes.`;
    case "verifier":
      return `Role contract:
- Verifier only. Run the provided checks and summarize pass/fail evidence.
- Finish with artifact type "verification_result".`;
    case "summarizer":
      return `Role contract:
- Summarizer only. Compress worker artifacts into a concise final handoff.
- Finish with artifact type "final_summary".`;
  }
}

function describeWorkflowGuidance(packet: import("../types/taskState.js").WorkerPacket): string {
  if (packet.workflow_phase !== "wrapup") return "";
  return `Workflow phase:
- This is the final wrap-up pass after verification.
- Clean up rough edges, remove obvious code smells, and update relevant docs/README usage notes.
- Use write_memory for durable lessons, gotchas, or conventions that future tasks should know.
- If git remote + GitHub CLI/auth are available, prefer creating a PR from the current branch.
- If PR creation is blocked, leave the branch PR-ready and record the blocker clearly in the finish artifact.`;
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

  ensureHomeMemory();
  ensureRepoMemory(repoPath);

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
      // Check if any files were written — if so, mark as done so dependents can proceed
      const filesExamined = JSON.parse(task.files_examined_json || "[]") as string[];
      const hasOutput = history.some((h) => h.role === "tool_result" && /write_file: success|apply_patch: success/.test(h.content));
      if (hasOutput) {
        updateTask(taskId, { status: "done", blocker: `max_steps reached (completed with output)` });
        emit("info", "budget", `max_steps reached — marking done (wrote files)`, { steps: task.steps_used, max_steps: task.max_steps });
      } else {
        updateTask(taskId, { status: "paused", blocker: `max_steps exceeded (${task.steps_used}/${task.max_steps})`, next_action: "operator" });
        emit("warn", "budget", `max_steps exceeded — ${task.steps_used}/${task.max_steps} steps used`, { steps: task.steps_used, max_steps: task.max_steps });
      }
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
    const skillContext = buildSkillIndex(repoPath);
    const packet = safeParsePacket(task.scope_json);
    const typedRole = isWorkerRole(task.role) ? task.role : null;
    const runtime = parseTaskRuntime(task.runtime_json);
    const roleContract = typedRole ? describeRoleContract(typedRole) : `Role contract: complete the task using the allowed tools and finish with a structured artifact when appropriate.`;
    const artifactContract = typedRole
      ? `Expected finish artifact type: ${expectedArtifactTypeForRole(typedRole)}`
      : `Expected finish artifact type: ${task.artifact_type || "(none specified)"}`;
    const workflowGuidance = describeWorkflowGuidance(packet);
    const sys = `You are a Grist coding agent. Task role: ${task.role}. Step ${stepNum} of max ${task.max_steps}.
OPTIMIZE FOR SPEED: minimize wall-clock time by running independent tools in parallel.

Allowed tools: ${allowed.join(", ")}
${canWrite ? `Tool reference:
- write_file: {"path": "relative/path.ext", "content": "full file content"} — creates or overwrites a file
- list_files: {"path": ".", "recursive": true} — list files in directory
- read_file: {"path": "relative/path.ext"} — read a file
- grep_code: {"pattern": "regex"} — search code
- run_command_safe: {"command": "npm install", "cwd": "."} — run a shell command in the repo/worktree
` : ""}
${allowed.includes("read_skill") ? `Skill reference:
- list_skills: {"scope":"visible"} — list installed skills for this repo
- read_skill: {"skillId":"frontend-debugger"} — load a skill before following it
` : ""}
Respond with JSON. You have two options:

1) Single tool: {"decision":"call_tool", "reasoning_summary":"...", "tool_name":"...", "tool_args":{...}}
2) Parallel tools (PREFERRED when independent): {"decision":"call_tools", "reasoning_summary":"...", "tool_calls":[{"tool_name":"...", "tool_args":{...}}, ...]}

Use call_tools to run independent operations in parallel — e.g. reading multiple files, writing independent files, or running grep while listing files. This cuts wall-clock time.

IMPORTANT:
- Do NOT read_file a file you just wrote — you already know its contents.
- Do NOT parallelize tools that depend on each other (e.g. read then write based on read).
- If Scope.files is non-empty, you may ONLY modify files in that list.
- If a write is rejected as outside scope, do not retry the same out-of-scope path. Adjust to the allowed files or finish with a concise explanation.
- In greenfield repos, prioritize a runnable end-to-end candidate over a beautifully decomposed but incomplete module split.
- Workers return artifacts, not essays. Keep reasoning terse and put the durable handoff into the artifact.
- Call write_memory when you discover something notable (architecture decisions, gotchas, conventions). Don't wait until the end.
- If you call "write_memory", always provide non-empty "content".
- After writing code, test it with run_command_safe when possible.
- Avoid raw docker/docker compose commands unless the task is specifically to author Docker setup. Grist handles task runtimes itself and raw Docker commands are often blocked.
- Avoid shell-only environment/version probes like "gh --version" unless you are confirming a blocker; prefer using the task goal to decide whether GitHub CLI is needed.
- When done, use {"decision":"finish", "reasoning_summary":"what was accomplished", "artifact":{"type":"...", "content":{...}}}.
- Never use legacy decision names like "write_artifact". If you are done, use "finish".
${roleContract}
${artifactContract}
${workflowGuidance}
Runtime:
- mode: ${runtime.mode}
- status: ${runtime.status}
- strategy: ${runtime.strategy}
- service URLs: ${runtime.serviceUrls.join(", ") || "(none)"}
- if a Docker runtime is running, run_command_safe / run_tests prefer that runtime automatically.
${skillContext ? `\n\n${skillContext}` : ""}`;

    const compacted = await compactHistory(history, provider, emit);
    // Replace history in-place when summarization reduced it
    if (compacted.length < history.length) {
      history.length = 0;
      history.push(...compacted);
    }
    const historyBlock = compacted.length
      ? "\n\nPrevious steps:\n" + compacted.map((h) => `[${h.role}]: ${h.content}`).join("\n")
      : "";

    const user = `Job goal: ${job.user_goal}
Operator notes: ${job.operator_notes || ""}
Task goal: ${task.goal}
Scope: ${task.scope_json}
Current action: ${task.current_action}
Findings so far: ${task.findings_json}
Open questions: ${task.open_questions_json}
Git branch: ${task.git_branch || "(none)"}
Base ref: ${task.base_ref || "(none)"}
Runtime metadata:
${JSON.stringify(runtime, null, 2)}
Worker packet:
${JSON.stringify(packet, null, 2)}${historyBlock}`;

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
          jsonSchema: WORKER_DECISION_JSON_SCHEMA,
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
      let raw = tryParseModelJson(JSON.stringify(resp.parsedJson ?? null)) ?? tryParseModelJson(resp.text);

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
              jsonSchema: WORKER_DECISION_JSON_SCHEMA,
              maxTokens: doubledMax,
              temperature: 0.2,
            });
            addJobTokenUsage(task.job_id, retryResp.tokensIn + retryResp.tokensOut, retryResp.estimatedCost);
            touchTaskActivity(taskId);
            const retryParsed = tryParseModelJson(JSON.stringify(retryResp.parsedJson ?? null)) ?? tryParseModelJson(retryResp.text);
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
      const obj = normalizeWorkerDecisionCandidate(raw, typedRole ? expectedArtifactTypeForRole(typedRole) : task.artifact_type || undefined);
      decision = WorkerDecisionSchema.parse(obj);
    } catch (e) {
      try {
        const repairPrompt = `Your previous output did not match the required JSON schema.

Validation error:
${String(e)}

Return corrected JSON only.
Do not use markdown fences.
Do not use legacy decision names like "write_artifact".
If done, use {"decision":"finish", ...}.

Invalid output:
${resp.text.slice(0, 12_000)}`;
        const repairResp = await provider.generateText({
          systemPrompt: `${sys}\nRepair the invalid JSON so it matches the schema exactly.`,
          userPrompt: repairPrompt,
          jsonSchema: WORKER_DECISION_JSON_SCHEMA,
          maxTokens: canWrite ? 8192 : 4096,
          temperature: 0,
        });
        addJobTokenUsage(task.job_id, repairResp.tokensIn + repairResp.tokensOut, repairResp.estimatedCost);
        touchTaskActivity(taskId);
        const repairedRaw = tryParseModelJson(repairResp.text);
        if (repairedRaw == null) throw new Error("repair returned no JSON");
        const repaired = normalizeWorkerDecisionCandidate(
          repairedRaw,
          typedRole ? expectedArtifactTypeForRole(typedRole) : task.artifact_type || undefined,
        );
        decision = WorkerDecisionSchema.parse(repaired);
        resp = repairResp;
        emit("warn", "parse_repaired", `Recovered invalid model output via repair pass`, { step: stepNum });
      } catch (repairError) {
        consecutiveErrors++;
        emit("warn", "parse_error", `${String(e)} (${consecutiveErrors}/3 consecutive)`, { raw: resp.text.slice(0, 2000), repair_error: String(repairError) });
        log({ timestamp: new Date().toISOString(), step: stepNum, type: "error", data: { parse_error: String(e), repair_error: String(repairError), raw: resp.text.slice(0, 4000) } });
        if (consecutiveErrors >= 3) {
          updateTask(taskId, { status: "failed", blocker: "invalid model JSON (3 consecutive parse errors)" });
          break;
        }
        history.push({ role: "tool_result", content: `[system] Your previous response was not valid JSON. Follow the exact schema, output one JSON object, and never use legacy decisions like write_artifact.` });
        continue;
      }
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
      const artifactToPersist: { type: string; content: unknown } | undefined = (() => {
        if (typedRole) {
          const expectedType = expectedArtifactTypeForRole(typedRole);
          if (!decision.artifact) {
            return {
              type: expectedType,
              content: defaultArtifactContentForRole(typedRole, decision.reasoning_summary || "done"),
            };
          }
          if (decision.artifact.type !== expectedType) {
            emit("warn", "artifact_type_mismatch", `Expected ${expectedType} for role ${typedRole}, got ${decision.artifact.type}. Using fallback artifact.`);
            return {
              type: expectedType,
              content: defaultArtifactContentForRole(typedRole, decision.reasoning_summary || "done"),
            };
          }
        }
        return decision.artifact ? { type: decision.artifact.type, content: decision.artifact.content } : undefined;
      })();
      if (artifactToPersist) {
        insertArtifact({
          job_id: cur.job_id,
          task_id: cur.id,
          type: artifactToPersist.type,
          content_json: JSON.stringify(artifactToPersist.content),
          confidence: tsu?.confidence ?? 0.7,
        });
      }
      updateTask(taskId, { status: "done", current_action: "finished", next_action: "" });
      emit("info", "task_done", decision.reasoning_summary || "done");

      // Capture git diff including untracked files
      try {
        const diffCwd = cur.worktree_path || repoPath;
        execSync("git add -A", { cwd: diffCwd, timeout: 5000 });
        const gitDiff = execSync("git diff --cached --stat && echo '---' && git diff --cached", { cwd: diffCwd, timeout: 10000, maxBuffer: 256 * 1024 }).toString().slice(0, 8000);
        execSync("git reset HEAD -- . 2>/dev/null || true", { cwd: diffCwd, timeout: 5000 });
        if (gitDiff.trim()) {
          emit("info", "task_diff", gitDiff, { diffCwd });
        }
      } catch { /* git diff is best-effort */ }

      // Async reflection to persist memory
      runReflection({
        taskId: cur.id,
        jobId: cur.job_id,
        repoPath,
        taskGoal: cur.goal,
        taskRole: cur.role,
        history: history.slice(-20),
        reasoning: decision.reasoning_summary || "done",
        provider,
        emit,
      }).catch(() => {});

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
