import { getDb } from "./db.js";

export function insertArtifact(row: {
  job_id: number;
  task_id: number | null;
  type: string;
  subtype?: string | null;
  content_json: string;
  confidence: number;
}): number {
  const t = new Date().toISOString();
  const r = getDb()
    .prepare(
      `INSERT INTO artifacts (job_id, task_id, type, subtype, content_json, confidence, created_at)
       VALUES (@job_id, @task_id, @type, @subtype, @content_json, @confidence, @created_at)`
    )
    .run({ ...row, subtype: row.subtype ?? null, created_at: t });
  return Number(r.lastInsertRowid);
}

export function listArtifactsForJob(jobId: number) {
  return getDb().prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY id ASC").all(jobId);
}

export function listArtifactsForTasks(jobId: number, taskIds: number[]) {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM artifacts WHERE job_id = ? AND task_id IN (${placeholders}) ORDER BY id ASC`)
    .all(jobId, ...taskIds);
}
