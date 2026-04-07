import { getDb } from "./db.js";

export function insertEvent(row: {
  job_id: number;
  task_id: number | null;
  level: string;
  type: string;
  message: string;
  data_json?: string | null;
}): number {
  const t = new Date().toISOString();
  const r = getDb()
    .prepare(
      `INSERT INTO events (job_id, task_id, level, type, message, data_json, created_at)
       VALUES (@job_id, @task_id, @level, @type, @message, @data_json, @created_at)`
    )
    .run({ ...row, data_json: row.data_json ?? null, created_at: t });
  return Number(r.lastInsertRowid);
}

export function listEvents(jobId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
    .all(jobId, limit);
}

export function listEventsForTask(jobId: number, taskId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?")
    .all(jobId, taskId, limit);
}

export function listJobLevelEvents(jobId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? AND task_id IS NULL ORDER BY id DESC LIMIT ?")
    .all(jobId, limit);
}
