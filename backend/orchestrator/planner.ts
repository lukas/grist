import { insertTask, updateTask } from "../db/taskRepo.js";
import { updateJob } from "../db/jobRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import type { JobRow } from "../db/jobRepo.js";
import type { ModelProviderName, TaskKind } from "../types/models.js";
import { scratchpadPath as scratchPath } from "../workspace/pathUtils.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";

const ANALYSIS_TOOLS = ALL_TOOL_NAMES.filter(
  (n) => !["write_file", "apply_patch", "create_worktree", "remove_worktree"].includes(n)
);
export interface PlanResult {
  taskIds: number[];
}

export function runPlanner(job: JobRow, appWorkspaceRoot: string): PlanResult {
  updateJob(job.id, { status: "planning" });
  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_start",
    message: "Planner decomposing goal",
    data_json: JSON.stringify({ goal: job.user_goal }),
  });

  const defaultP = job.default_model_provider as ModelProviderName;

  const specs: {
    kind: TaskKind;
    role: string;
    goal: string;
    scope: Record<string, unknown>;
    deps: number[];
    allowed: string[];
    write_mode: "none" | "worktree";
    workspace_mode: "shared_read_only" | "isolated_worktree";
    artifact_type: string;
    max_steps: number;
    max_tokens: number;
    priority: number;
    provider: ModelProviderName;
  }[] = [
    {
      kind: "analysis",
      role: "backend_scan",
      goal: `Inspect backend/server code paths relevant to: ${job.user_goal}`,
      scope: { area: "backend" },
      deps: [],
      allowed: ANALYSIS_TOOLS,
      write_mode: "none",
      workspace_mode: "shared_read_only",
      artifact_type: "findings_report",
      max_steps: 24,
      max_tokens: 32000,
      priority: 10,
      provider: defaultP,
    },
    {
      kind: "analysis",
      role: "frontend_scan",
      goal: `Inspect frontend/UI paths relevant to: ${job.user_goal}`,
      scope: { area: "frontend" },
      deps: [],
      allowed: ANALYSIS_TOOLS,
      write_mode: "none",
      workspace_mode: "shared_read_only",
      artifact_type: "findings_report",
      max_steps: 24,
      max_tokens: 32000,
      priority: 9,
      provider: defaultP,
    },
    {
      kind: "analysis",
      role: "tests_logs_scan",
      goal: `Inspect tests, CI, and logs for: ${job.user_goal}`,
      scope: { area: "tests" },
      deps: [],
      allowed: ANALYSIS_TOOLS,
      write_mode: "none",
      workspace_mode: "shared_read_only",
      artifact_type: "findings_report",
      max_steps: 20,
      max_tokens: 24000,
      priority: 8,
      provider: defaultP,
    },
    {
      kind: "analysis",
      role: "infra_config_scan",
      goal: `Inspect config/infra for: ${job.user_goal}`,
      scope: { area: "infra" },
      deps: [],
      allowed: ANALYSIS_TOOLS,
      write_mode: "none",
      workspace_mode: "shared_read_only",
      artifact_type: "findings_report",
      max_steps: 18,
      max_tokens: 24000,
      priority: 7,
      provider: defaultP,
    },
  ];

  const taskIds: number[] = [];
  for (const s of specs) {
    const id = insertTask({
      job_id: job.id,
      parent_task_id: null,
      kind: s.kind,
      role: s.role,
      goal: s.goal,
      scope_json: JSON.stringify(s.scope),
      status: "queued",
      priority: s.priority,
      assigned_model_provider: s.provider,
      write_mode: s.write_mode,
      workspace_repo_mode: s.workspace_mode,
      scratchpad_path: "",
      worktree_path: null,
      max_steps: s.max_steps,
      max_tokens: s.max_tokens,
      current_action: "queued",
      next_action: "start",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify(s.deps),
      allowed_tools_json: JSON.stringify(s.allowed),
      artifact_type: s.artifact_type,
    });
    taskIds.push(id);
  }

  for (const tid of taskIds.slice(0, specs.length)) {
    updateTask(tid, { scratchpad_path: scratchPath(appWorkspaceRoot, job.id, tid) });
  }

  const reducerDeps = [...taskIds];
  const reducerId = insertTask({
    job_id: job.id,
    parent_task_id: null,
    kind: "reducer",
    role: "reducer",
    goal: `Synthesize findings for: ${job.user_goal}`,
    scope_json: JSON.stringify({}),
    status: "blocked",
    priority: 100,
    assigned_model_provider: job.reducer_model_provider as ModelProviderName,
    write_mode: "none",
    workspace_repo_mode: "shared_read_only",
    scratchpad_path: "",
    worktree_path: null,
    max_steps: 4,
    max_tokens: 16000,
    current_action: "blocked",
    next_action: "wait_deps",
    blocker: "waiting for analysis tasks",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: JSON.stringify(reducerDeps),
    allowed_tools_json: JSON.stringify(["read_artifacts", "write_artifact", "read_scratchpad", "emit_progress_event"]),
    artifact_type: "reducer_summary",
  });
  taskIds.push(reducerId);
  updateTask(reducerId, { scratchpad_path: scratchPath(appWorkspaceRoot, job.id, reducerId) });

  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_done",
    message: `Created ${taskIds.length} tasks`,
    data_json: JSON.stringify({ taskIds }),
  });

  updateJob(job.id, { status: "running" });
  return { taskIds };
}
