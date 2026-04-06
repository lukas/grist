import { getTask, updateTask, touchTaskActivity } from "../db/taskRepo.js";
import { getJob, addJobTokenUsage } from "../db/jobRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { WorkerDecisionSchema } from "../types/taskState.js";
import { executeTool } from "../tools/executeTool.js";
import type { ToolContext } from "../tools/toolTypes.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import { runReducerPass } from "./reducer.js";
import { runVerifierPass } from "./verifier.js";

function buildToolContext(
  task: NonNullable<ReturnType<typeof getTask>>,
  jobRepoPath: string,
  appWorkspaceRoot: string,
  commandAllowlist: string[],
  emit: ToolContext["emit"]
): ToolContext {
  const t = task;
  const allowed = JSON.parse(t.allowed_tools_json) as string[];
  return {
    jobId: t.job_id,
    taskId: t.id,
    repoPath: jobRepoPath,
    worktreePath: t.worktree_path,
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
  onDuplicateHint?: (msg: string) => void
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

  ensureScratchpad(row.scratchpad_path);
  const signatures: string[] = [];

  const emit = (level: "info" | "warn" | "error", type: string, message: string, data?: unknown) => {
    insertEvent({
      job_id: row.job_id,
      task_id: row.id,
      level,
      type,
      message,
      data_json: data != null ? JSON.stringify(data) : null,
    });
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
      updateTask(taskId, { status: "paused", blocker: "max_steps exceeded", next_action: "operator" });
      emit("warn", "budget", "max_steps exceeded", { steps: task.steps_used });
      break;
    }
    if (task.tokens_used >= task.max_tokens) {
      updateTask(taskId, { status: "paused", blocker: "max_tokens exceeded" });
      emit("warn", "budget", "max_tokens exceeded", { tokens: task.tokens_used });
      break;
    }

    const sys = `You are a coding swarm worker. Task role: ${task.role}. One tool per turn.
Allowed tools: ${task.allowed_tools_json}
Respond ONLY with JSON matching the worker decision schema (decision: call_tool|finish|pause_self).`;
    const user = `Job goal: ${job.user_goal}
Operator notes: ${job.operator_notes || ""}
Task goal: ${task.goal}
Scope: ${task.scope_json}
Scratchpad path: ${task.scratchpad_path}
Current action: ${task.current_action}
Findings so far: ${task.findings_json}
Open questions: ${task.open_questions_json}`;

    let resp;
    try {
      resp = await provider.generateStructured({
        systemPrompt: sys,
        userPrompt: user,
        maxTokens: 2048,
        temperature: 0.2,
      });
    } catch (e) {
      emit("error", "model_error", String(e));
      updateTask(taskId, { status: "failed", blocker: String(e) });
      break;
    }

    addJobTokenUsage(task.job_id, resp.tokensIn + resp.tokensOut, resp.estimatedCost);
    const tokens = task.tokens_used + resp.tokensIn + resp.tokensOut;
    updateTask(taskId, {
      tokens_used: tokens,
      steps_used: task.steps_used + 1,
    });
    touchTaskActivity(taskId);

    let decision;
    try {
      const raw =
        resp.parsedJson ??
        (() => {
          try {
            return JSON.parse(resp.text) as unknown;
          } catch {
            return null;
          }
        })();
      if (raw == null) throw new Error("empty decision");
      decision = WorkerDecisionSchema.parse(raw);
    } catch (e) {
      emit("error", "parse_error", String(e), { raw: resp.text.slice(0, 2000) });
      updateTask(taskId, { status: "failed", blocker: "invalid model JSON" });
      break;
    }

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

    if (decision.decision === "call_tool") {
      const name = decision.tool_name || "";
      const args = (decision.tool_args || {}) as Record<string, unknown>;
      const sig = `${name}:${JSON.stringify(args)}`;
      signatures.push(sig);
      if (signatures.length >= 3) {
        const last3 = signatures.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          onDuplicateHint?.("Repeated identical tool pattern x3");
          emit("warn", "duplicate_work_hint", "Repeated identical tool pattern", { sig });
        }
      }

      const tr = getTask(taskId);
      if (!tr) break;
      const ctx = buildToolContext(tr, job.repo_path, appWorkspaceRoot, settings.commandAllowlist || [], emit);
      const result = await executeTool(name, args, ctx, signal);
      emit("info", "tool_result", `${name}`, { result });
      touchTaskActivity(taskId);
      const fresh = getTask(taskId)!;
      const files = JSON.parse(fresh.files_examined_json || "[]") as string[];
      if (name === "read_file" && typeof args.path === "string" && !files.includes(args.path)) {
        files.push(args.path);
        updateTask(taskId, { files_examined_json: JSON.stringify(files) });
      }
    }
  }
}
