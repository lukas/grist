import { listTasksForJob, updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { getJob, updateJob } from "../db/jobRepo.js";

export const MAX_PARALLEL = 4;
const STALL_MS = 30_000;

function depsSatisfied(task: TaskRow, byId: Map<number, TaskRow>): boolean {
  const deps = JSON.parse(task.dependencies_json || "[]") as number[];
  if (deps.length === 0) return true;
  return deps.every((id) => byId.get(id)?.status === "done");
}

function terminalJobState(tasks: TaskRow[]): boolean {
  const active = tasks.filter((t) =>
    ["queued", "ready", "running", "blocked", "paused"].includes(t.status)
  );
  return active.length === 0;
}

export interface SchedulerHooks {
  onStartWorker: (taskId: number) => void;
}

export function runSchedulerTick(jobId: number, hooks: SchedulerHooks): void {
  const job = getJob(jobId);
  if (!job || !["running", "paused"].includes(job.status)) return;

  let tasks = listTasksForJob(jobId);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    if (t.status === "running") {
      const last = new Date(t.last_activity_at).getTime();
      if (Date.now() - last > STALL_MS) {
        updateTask(t.id, { stalled: 1 });
        insertEvent({
          job_id: jobId,
          task_id: t.id,
          level: "warn",
          type: "stall",
          message: `No activity for >${STALL_MS / 1000}s`,
        });
      }
    }
  }

  tasks = listTasksForJob(jobId);
  for (const t of tasks) {
    if (t.status === "blocked") {
      const m = new Map(listTasksForJob(jobId).map((x) => [x.id, x]));
      if (depsSatisfied(t, m)) {
        updateTask(t.id, {
          status: "queued",
          blocker: "",
          current_action: "unblocked",
          next_action: "schedule",
        });
        insertEvent({
          job_id: jobId,
          task_id: t.id,
          level: "info",
          type: "task_unblocked",
          message: "Dependencies satisfied",
        });
      }
    }
  }

  if (job.status === "paused") return;

  tasks = listTasksForJob(jobId);
  const byIdReady = new Map(tasks.map((x) => [x.id, x]));
  for (const t of tasks) {
    if (t.status === "queued" && depsSatisfied(t, byIdReady)) {
      updateTask(t.id, { status: "ready", next_action: "launch" });
    }
  }

  tasks = listTasksForJob(jobId);
  const running = tasks.filter((t) => t.status === "running");
  let slots = MAX_PARALLEL - running.length;
  if (slots <= 0) return;

  const ready = tasks
    .filter((t) => t.status === "ready")
    .sort((a, b) => b.priority - a.priority || a.id - b.id);

  for (const t of ready) {
    if (slots <= 0) break;
    updateTask(t.id, { status: "running", current_action: "worker_start", last_activity_at: new Date().toISOString() });
    hooks.onStartWorker(t.id);
    slots -= 1;
  }

  tasks = listTasksForJob(jobId);
  if (job.status === "running" && terminalJobState(tasks)) {
    updateJob(jobId, { status: "completed" });
    insertEvent({
      job_id: jobId,
      task_id: null,
      level: "info",
      type: "job_completed",
      message: "All tasks terminal",
    });
  }
}

export { depsSatisfied };
