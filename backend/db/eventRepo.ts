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
    .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id ASC LIMIT ?")
    .all(jobId, limit);
}

export function listEventsForTask(jobId: number, taskId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? AND task_id = ? ORDER BY id ASC LIMIT ?")
    .all(jobId, taskId, limit);
}

export function listJobLevelEvents(jobId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? AND task_id IS NULL ORDER BY id ASC LIMIT ?")
    .all(jobId, limit);
}

export function listEventsByTaskId(taskId: number, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC LIMIT ?")
    .all(taskId, limit);
}

export function listErrorEvents(jobId: number, limit = 200) {
  return getDb()
    .prepare(
      "SELECT * FROM events WHERE job_id = ? AND level IN ('error', 'warning') ORDER BY id ASC LIMIT ?"
    )
    .all(jobId, limit);
}

export function countEventsByType(jobId: number) {
  return getDb()
    .prepare(
      "SELECT type, COUNT(*) as count FROM events WHERE job_id = ? GROUP BY type ORDER BY count DESC"
    )
    .all(jobId) as { type: string; count: number }[];
}

export function listEventsByType(jobId: number, type: string, limit = 500) {
  return getDb()
    .prepare("SELECT * FROM events WHERE job_id = ? AND type = ? ORDER BY id ASC LIMIT ?")
    .all(jobId, type, limit);
}
