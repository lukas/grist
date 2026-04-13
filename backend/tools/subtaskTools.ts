import type { ToolContext, ToolResult } from "./toolTypes.js";
import { insertTask, updateTask, getTask } from "../db/taskRepo.js";
import { scratchpadPath } from "../workspace/pathUtils.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";

interface SubtaskSpec {
  goal: string;
  role?: string;
  can_write?: boolean;
}

const WRITE_DENY = new Set(["write_file", "apply_patch", "create_worktree", "remove_worktree"]);

export function toolSpawnSubtasks(
  ctx: ToolContext,
  args: { tasks: SubtaskSpec[]; wait?: boolean },
): ToolResult {
  const { tasks, wait = true } = args;

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: "tasks must be a non-empty array of {goal, role?, can_write?}" };
  }
  if (tasks.length > 10) {
    return { ok: false, error: "max 10 subtasks per spawn" };
  }

  const parent = getTask(ctx.taskId);
  if (!parent) return { ok: false, error: "parent task not found" };

  // Derive child tool lists from parent's allowed tools
  const parentTools = JSON.parse(parent.allowed_tools_json) as string[];
  const writeTools = parentTools.includes("spawn_subtasks") ? parentTools : [...parentTools, "spawn_subtasks"];
  const readTools = writeTools.filter((n) => !WRITE_DENY.has(n));

  const taskIds: number[] = [];
  const labels: string[] = [];

  for (const spec of tasks) {
    if (!spec.goal || typeof spec.goal !== "string") continue;

    const canWrite = spec.can_write ?? true;
    const role = spec.role || spec.goal.slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, "_");
    const allowed = canWrite ? writeTools : readTools;

    const id = insertTask({
      job_id: parent.job_id,
      parent_task_id: parent.id,
      kind: canWrite ? "patch_writer" : "analysis",
      role,
      goal: spec.goal,
      scope_json: "{}",
      status: "queued",
      priority: parent.priority - 1,
      assigned_model_provider: parent.assigned_model_provider,
      write_mode: canWrite ? "worktree" : "none",
      workspace_repo_mode: canWrite ? "isolated_worktree" : "shared_read_only",
      scratchpad_path: "",
      worktree_path: canWrite ? null : parent.worktree_path,
      git_branch: "",
      base_ref: parent.base_ref,
      runtime_json: "{}",
      max_steps: 30,
      max_tokens: 48000,
      current_action: "queued",
      next_action: "start",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(allowed),
      artifact_type: canWrite ? "candidate_patch" : "findings_report",
    });

    const sp = scratchpadPath(ctx.appWorkspaceRoot, parent.job_id, id);
    updateTask(id, { scratchpad_path: sp });
    ensureScratchpad(sp);

    taskIds.push(id);
    labels.push(role);
  }

  if (taskIds.length === 0) {
    return { ok: false, error: "no valid subtask specs provided" };
  }

  if (wait) {
    updateTask(ctx.taskId, {
      status: "blocked",
      blocker: `waiting for subtasks: ${taskIds.join(",")}`,
      current_action: "waiting_subtasks",
    });
  }

  ctx.emit("info", "subtasks_spawned", `Spawned ${taskIds.length} subtasks: ${labels.join(", ")}`, {
    taskIds, labels, wait,
  });

  const msg = wait
    ? `Spawned ${taskIds.length} subtasks (${labels.join(", ")}). You are now blocked until they finish. Their summaries will appear in your context when they complete.`
    : `Spawned ${taskIds.length} subtasks (${labels.join(", ")}). They run in parallel — results will appear in your context as they finish. You can keep working.`;

  return { ok: true, data: { taskIds, labels, wait, message: msg } };
}
