import { getTask, insertTask, updateTask, listTasksForJob } from "../db/taskRepo.js";
import { getJob } from "../db/jobRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { getLatestArtifactForTask } from "../db/artifactRepo.js";
import type { ToolContext, ToolResult } from "./toolTypes.js";
import { scratchpadPath } from "../workspace/pathUtils.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";

const SUBTASK_EXCLUDED_TOOLS = new Set(["remove_worktree", "create_worktree", "spawn_subtask", "poll_subtask"]);

function getSubtaskAllowedTools(): string[] {
  // Inline the standard tool list to avoid circular dependency with executeTool.ts
  const all = [
    "list_files", "grep_code", "read_file", "read_git_history", "list_changed_files",
    "read_artifacts", "write_artifact", "read_scratchpad", "write_scratchpad", "append_scratchpad",
    "run_tests", "run_lint", "run_command_safe", "write_file", "apply_patch",
    "get_worktree_diff", "emit_progress_event", "pause_self", "ask_user",
    "write_memory", "read_memory", "list_skills", "read_skill",
    "run_command_bg", "poll_command",
  ];
  return all.filter((n) => !SUBTASK_EXCLUDED_TOOLS.has(n));
}

export function toolSpawnSubtask(
  ctx: ToolContext,
  args: { goal: string; files?: string[]; approach?: string },
): ToolResult {
  const parentTask = getTask(ctx.taskId);
  const job = parentTask ? getJob(parentTask.job_id) : undefined;
  if (!parentTask || !job) {
    return { ok: false, error: "Parent task or job not found" };
  }

  if (parentTask.role !== "implementer") {
    return { ok: false, error: `Only implementers can spawn subtasks, not ${parentTask.role}` };
  }

  const existingChildren = listTasksForJob(parentTask.job_id).filter(
    (t) => t.parent_task_id === parentTask.id && t.role === "implementer" && t.kind === "patch_writer"
      && !["done", "failed", "stopped", "superseded"].includes(t.status)
  );
  if (existingChildren.length >= 3) {
    return { ok: false, error: "Maximum 3 active subtasks per parent. Wait for existing subtasks to complete." };
  }

  const fileOwnership = args.files && args.files.length > 0 ? args.files : ["**/*"];
  const scopeJson = JSON.stringify({
    files: args.files || [],
    contract_json: {
      inputs: [],
      outputs: ["candidate_patch"],
      file_ownership: fileOwnership,
      acceptance_criteria: [],
      non_goals: [],
    },
  });

  const subtaskId = insertTask({
    job_id: parentTask.job_id,
    parent_task_id: parentTask.id,
    kind: "patch_writer",
    role: "implementer",
    goal: args.approach ? `${args.goal}\n\nApproach: ${args.approach}` : args.goal,
    scope_json: scopeJson,
    status: "queued",
    priority: parentTask.priority + 5,
    assigned_model_provider: parentTask.assigned_model_provider,
    write_mode: "worktree",
    workspace_repo_mode: "isolated_worktree",
    scratchpad_path: "",
    worktree_path: null,
    git_branch: "",
    base_ref: parentTask.base_ref || "",
    runtime_json: "{}",
    max_steps: Math.min(parentTask.max_steps, 24),
    max_tokens: Math.min(parentTask.max_tokens, 120_000),
    current_action: "subtask_init",
    next_action: "start",
    blocker: "",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: "[]",
    allowed_tools_json: JSON.stringify(getSubtaskAllowedTools()),
    artifact_type: "candidate_patch",
  });

  const sp = scratchpadPath(ctx.appWorkspaceRoot, parentTask.job_id, subtaskId);
  updateTask(subtaskId, { scratchpad_path: sp });
  ensureScratchpad(sp);

  insertEvent({
    job_id: parentTask.job_id,
    task_id: subtaskId,
    level: "info",
    type: "subtask_spawned",
    message: `Subtask spawned by parent task ${parentTask.id}: ${args.goal.slice(0, 100)}`,
    data_json: JSON.stringify({ parentTaskId: parentTask.id, goal: args.goal, files: args.files }),
  });

  return {
    ok: true,
    data: {
      subtask_id: subtaskId,
      goal: args.goal,
      status: "queued",
      message: "Subtask created. Use poll_subtask to check when it's done.",
    },
  };
}

export function toolPollSubtask(
  ctx: ToolContext,
  args: { subtask_id: number },
): ToolResult {
  const subtask = getTask(args.subtask_id);
  if (!subtask) {
    return { ok: false, error: `Subtask ${args.subtask_id} not found` };
  }
  if (subtask.parent_task_id !== ctx.taskId) {
    return { ok: false, error: `Subtask ${args.subtask_id} is not a child of the current task` };
  }

  const done = ["done", "failed", "stopped", "superseded"].includes(subtask.status);
  const result: Record<string, unknown> = {
    subtask_id: subtask.id,
    status: subtask.status,
    done,
    goal: subtask.goal,
    steps_used: subtask.steps_used,
    current_action: subtask.current_action,
    blocker: subtask.blocker || null,
  };

  if (done) {
    const artifact = getLatestArtifactForTask(subtask.id, "candidate_patch") as { content_json: string } | undefined;
    if (artifact) {
      try {
        result.artifact = JSON.parse(artifact.content_json);
      } catch {
        result.artifact = artifact.content_json;
      }
    }
  }

  return { ok: true, data: result };
}
