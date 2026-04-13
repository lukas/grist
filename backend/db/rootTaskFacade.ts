/**
 * Facade that presents "jobs" as "root tasks" to the rest of the system.
 * Internally still uses the jobs + tasks tables, but exposes a unified
 * task-shaped API so the frontend and orchestrator never see "jobs".
 */
import { getDb } from "./db.js";
import { insertJob, getJob, updateJob, listJobs, type JobRow } from "./jobRepo.js";
import { insertTask, getTask, updateTask, listTasksForJob, type TaskRow } from "./taskRepo.js";
import type { ModelProviderName, TaskStatus } from "../types/models.js";
import { ensureGitRepo } from "../workspace/gitRepoManager.js";

export interface RootTaskSummary {
  id: number;
  user_goal: string;
  status: TaskStatus;
  repo_path: string;
  created_at: string;
  updated_at: string;
}

export interface RootTaskRow extends RootTaskSummary {
  operator_notes: string;
  default_model_provider: ModelProviderName;
  planner_model_provider: ModelProviderName;
  reducer_model_provider: ModelProviderName;
  verifier_model_provider: ModelProviderName;
  total_tokens_used: number;
  total_estimated_cost: number;
  /** The underlying job ID (hidden from frontend) */
  _jobId: number;
}

const jobStatusToTaskStatus: Record<string, TaskStatus> = {
  draft: "queued",
  planning: "running",
  running: "running",
  paused: "paused",
  reducing: "running",
  verifying: "running",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

function jobToRootSummary(job: JobRow, rootTaskId: number): RootTaskSummary {
  return {
    id: rootTaskId,
    user_goal: job.user_goal,
    status: jobStatusToTaskStatus[job.status] ?? "queued",
    repo_path: job.repo_path,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function jobToRootRow(job: JobRow, rootTaskId: number): RootTaskRow {
  return {
    ...jobToRootSummary(job, rootTaskId),
    operator_notes: job.operator_notes,
    default_model_provider: job.default_model_provider,
    planner_model_provider: job.planner_model_provider,
    reducer_model_provider: job.reducer_model_provider,
    verifier_model_provider: job.verifier_model_provider,
    total_tokens_used: job.total_tokens_used,
    total_estimated_cost: job.total_estimated_cost,
    _jobId: job.id,
  };
}

/**
 * Create a root task (internally creates a job + a "root" task row).
 * Returns the root task's ID — the only ID the frontend should use.
 */
export function createRootTask(input: {
  repoPath: string;
  goal: string;
  notes?: string;
  defaultProvider?: ModelProviderName;
  plannerProvider?: ModelProviderName;
  reducerProvider?: ModelProviderName;
  verifierProvider?: ModelProviderName;
}): number {
  const d = input.defaultProvider || "mock";
  ensureGitRepo(input.repoPath);
  const jobId = insertJob({
    repo_path: input.repoPath,
    user_goal: input.goal,
    operator_notes: input.notes || "",
    status: "draft",
    selected_execution_mode: "local",
    default_model_provider: d,
    planner_model_provider: input.plannerProvider || d,
    reducer_model_provider: input.reducerProvider || d,
    verifier_model_provider: input.verifierProvider || d,
  });

  const rootTaskId = insertTask({
    job_id: jobId,
    parent_task_id: null,
    kind: "root",
    role: "root",
    goal: input.goal,
    scope_json: "{}",
    status: "queued",
    priority: 1000,
    assigned_model_provider: d,
    write_mode: "none",
    workspace_repo_mode: "shared_read_only",
    scratchpad_path: "",
    worktree_path: null,
    git_branch: "",
    base_ref: "",
    runtime_json: "{}",
    max_steps: 0,
    max_tokens: 0,
    current_action: "created",
    next_action: "plan",
    blocker: "",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: "[]",
    allowed_tools_json: "[]",
    artifact_type: "",
  });

  return rootTaskId;
}

/**
 * List root tasks (most recent first), optionally filtered by repo.
 */
export function listRootTasks(repo?: string): RootTaskSummary[] {
  const jobs = listJobs();
  const result: RootTaskSummary[] = [];
  for (const job of jobs) {
    if (repo && job.repo_path !== repo) continue;
    const rootTask = findRootTaskForJob(job.id);
    const rootId = rootTask?.id ?? -job.id;
    result.push(jobToRootSummary(job, rootId));
  }
  return result;
}

/**
 * Get a root task by its task ID.
 */
export function getRootTask(rootTaskId: number): RootTaskRow | undefined {
  const task = getTask(rootTaskId);
  if (!task || task.kind !== "root") return undefined;
  const job = getJob(task.job_id);
  if (!job) return undefined;
  return jobToRootRow(job, rootTaskId);
}

/**
 * Resolve a root task ID to the underlying job ID.
 */
export function rootTaskToJobId(rootTaskId: number): number | undefined {
  const task = getTask(rootTaskId);
  if (!task || task.kind !== "root") return undefined;
  return task.job_id;
}

/**
 * Resolve a job ID to its root task ID.
 */
export function jobIdToRootTask(jobId: number): number | undefined {
  return findRootTaskForJob(jobId)?.id;
}

/**
 * Get all child tasks for a root task (excluding the root itself).
 */
export function getChildTasks(rootTaskId: number): TaskRow[] {
  const task = getTask(rootTaskId);
  if (!task) return [];
  return listTasksForJob(task.job_id).filter((t) => t.kind !== "root");
}

/**
 * Update root task status (propagates to underlying job).
 */
export function updateRootTaskStatus(rootTaskId: number, status: TaskStatus): void {
  const taskStatusToJobStatus: Record<string, string> = {
    queued: "draft",
    running: "running",
    paused: "paused",
    done: "completed",
    failed: "failed",
    stopped: "stopped",
  };
  const task = getTask(rootTaskId);
  if (!task || task.kind !== "root") return;
  updateTask(rootTaskId, { status });
  const jobStatus = taskStatusToJobStatus[status];
  if (jobStatus) updateJob(task.job_id, { status: jobStatus as never });
}

function findRootTaskForJob(jobId: number): TaskRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM tasks WHERE job_id = ? AND kind = 'root' LIMIT 1")
    .get(jobId) as TaskRow | undefined;
}

export { findRootTaskForJob };
