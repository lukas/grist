import { getDb } from "./db.js";
import type { TaskKind, TaskStatus, WriteMode, WorkspaceRepoMode, ModelProviderName } from "../types/models.js";

export interface TaskRow {
  id: number;
  job_id: number;
  parent_task_id: number | null;
  kind: TaskKind;
  role: string;
  goal: string;
  scope_json: string;
  status: TaskStatus;
  priority: number;
  assigned_model_provider: ModelProviderName;
  write_mode: WriteMode;
  workspace_repo_mode: WorkspaceRepoMode;
  scratchpad_path: string;
  worktree_path: string | null;
  git_branch: string;
  base_ref: string;
  runtime_json: string;
  max_steps: number;
  max_tokens: number;
  steps_used: number;
  tokens_used: number;
  current_action: string;
  next_action: string;
  blocker: string;
  confidence: number;
  files_examined_json: string;
  findings_json: string;
  open_questions_json: string;
  dependencies_json: string;
  allowed_tools_json: string;
  artifact_type: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  stalled: number;
}

const now = () => new Date().toISOString();

export function insertTask(
  row: Omit<
    TaskRow,
    "id" | "created_at" | "updated_at" | "steps_used" | "tokens_used" | "stalled" | "last_activity_at"
  >
): number {
  const db = getDb();
  const t = now();
  const r = db
    .prepare(
      `INSERT INTO tasks (
        job_id, parent_task_id, kind, role, goal, scope_json, status, priority,
        assigned_model_provider, write_mode, workspace_repo_mode, scratchpad_path, worktree_path,
        git_branch, base_ref, runtime_json,
        max_steps, max_tokens, steps_used, tokens_used,
        current_action, next_action, blocker, confidence,
        files_examined_json, findings_json, open_questions_json, dependencies_json, allowed_tools_json,
        artifact_type, created_at, updated_at, last_activity_at, stalled
      ) VALUES (
        @job_id, @parent_task_id, @kind, @role, @goal, @scope_json, @status, @priority,
        @assigned_model_provider, @write_mode, @workspace_repo_mode, @scratchpad_path, @worktree_path,
        @git_branch, @base_ref, @runtime_json,
        @max_steps, @max_tokens, 0, 0,
        @current_action, @next_action, @blocker, @confidence,
        @files_examined_json, @findings_json, @open_questions_json, @dependencies_json, @allowed_tools_json,
        @artifact_type, @created_at, @updated_at, @last_activity_at, 0
      )`
    )
    .run({ ...row, created_at: t, updated_at: t, last_activity_at: t });
  return Number(r.lastInsertRowid);
}

export function updateTask(id: number, patch: Partial<Omit<TaskRow, "id" | "job_id">>): void {
  const db = getDb();
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: now(),
  });
}

export function touchTaskActivity(id: number): void {
  getDb()
    .prepare(`UPDATE tasks SET last_activity_at = @t, stalled = 0, updated_at = @t WHERE id = @id`)
    .run({ id, t: now() });
}

export function getTask(id: number): TaskRow | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export function listTasksForJob(jobId: number): TaskRow[] {
  return getDb().prepare("SELECT * FROM tasks WHERE job_id = ? ORDER BY priority DESC, id ASC").all(jobId) as TaskRow[];
}

export function listRunnableTasks(jobId: number): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE job_id = ? AND status IN ('queued', 'ready', 'running', 'paused', 'blocked') ORDER BY priority DESC, id ASC`
    )
    .all(jobId) as TaskRow[];
}
