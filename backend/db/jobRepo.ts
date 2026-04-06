import { getDb } from "./db.js";
import type { JobStatus, ModelProviderName } from "../types/models.js";

export interface JobRow {
  id: number;
  repo_path: string;
  user_goal: string;
  operator_notes: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  selected_execution_mode: string;
  default_model_provider: ModelProviderName;
  planner_model_provider: ModelProviderName;
  reducer_model_provider: ModelProviderName;
  verifier_model_provider: ModelProviderName;
  total_tokens_used: number;
  total_estimated_cost: number;
}

const now = () => new Date().toISOString();

export function insertJob(row: Omit<JobRow, "id" | "created_at" | "updated_at" | "total_tokens_used" | "total_estimated_cost">): number {
  const db = getDb();
  const t = now();
  const r = db
    .prepare(
      `INSERT INTO jobs (repo_path, user_goal, operator_notes, status, created_at, updated_at,
        selected_execution_mode, default_model_provider, planner_model_provider, reducer_model_provider,
        verifier_model_provider, total_tokens_used, total_estimated_cost)
       VALUES (@repo_path, @user_goal, @operator_notes, @status, @created_at, @updated_at,
        @selected_execution_mode, @default_model_provider, @planner_model_provider, @reducer_model_provider,
        @verifier_model_provider, 0, 0)`
    )
    .run({
      ...row,
      created_at: t,
      updated_at: t,
    });
  return Number(r.lastInsertRowid);
}

export function updateJob(
  id: number,
  patch: Partial<
    Pick<
      JobRow,
      | "status"
      | "operator_notes"
      | "default_model_provider"
      | "planner_model_provider"
      | "reducer_model_provider"
      | "verifier_model_provider"
      | "total_tokens_used"
      | "total_estimated_cost"
    >
  >
): void {
  const db = getDb();
  const keys = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: now(),
  });
}

export function getJob(id: number): JobRow | undefined {
  return getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return getDb().prepare("SELECT * FROM jobs ORDER BY id DESC").all() as JobRow[];
}

export function addJobTokenUsage(id: number, tokens: number, cost: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE jobs SET total_tokens_used = total_tokens_used + @t, total_estimated_cost = total_estimated_cost + @c, updated_at = @u WHERE id = @id`
  ).run({ id, t: tokens, c: cost, u: now() });
}
