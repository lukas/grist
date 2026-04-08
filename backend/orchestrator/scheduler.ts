import { listTasksForJob, updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { getJob, updateJob } from "../db/jobRepo.js";

export const MAX_PARALLEL = 4;
const STALL_WARN_MS = 30_000;
const STALL_PAUSE_MS = 5 * 60_000;
const STALL_FAIL_MS = 15 * 60_000;
const NON_SCHEDULABLE_KINDS = new Set(["root", "planner"]);

function depsSatisfied(task: TaskRow, byId: Map<number, TaskRow>): boolean {
  const deps = JSON.parse(task.dependencies_json || "[]") as number[];
  if (deps.length === 0) return true;
  return deps.every((id) => byId.get(id)?.status === "done");
}

function schedulable(t: TaskRow): boolean {
  return !NON_SCHEDULABLE_KINDS.has(t.kind);
}

function terminalJobState(tasks: TaskRow[]): "completed" | "failed" | null {
  const work = tasks.filter(schedulable);
  if (work.length === 0) return null;
  const active = work.filter((t) =>
    ["queued", "ready", "running", "blocked", "paused"].includes(t.status)
  );
  if (active.length > 0) return null;
  const anyFailed = work.some((t) => t.status === "failed");
  return anyFailed ? "failed" : "completed";
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
    if (t.status === "running" && schedulable(t)) {
      if (t.current_action === "thinking") continue;
      const elapsed = Date.now() - new Date(t.last_activity_at).getTime();
      if (elapsed > STALL_FAIL_MS && t.stalled) {
        updateTask(t.id, { status: "failed", blocker: `Stalled for >${STALL_FAIL_MS / 60_000}min` });
        insertEvent({ job_id: jobId, task_id: t.id, level: "error", type: "stall_fail", message: `No activity for >${STALL_FAIL_MS / 60_000}min — failing task` });
      } else if (elapsed > STALL_PAUSE_MS && t.stalled) {
        updateTask(t.id, { status: "paused", blocker: `Stalled for >${STALL_PAUSE_MS / 60_000}min` });
        insertEvent({ job_id: jobId, task_id: t.id, level: "warn", type: "stall_pause", message: `No activity for >${STALL_PAUSE_MS / 60_000}min — auto-pausing` });
      } else if (elapsed > STALL_WARN_MS && !t.stalled) {
        updateTask(t.id, { stalled: 1 });
        insertEvent({ job_id: jobId, task_id: t.id, level: "warn", type: "stall", message: `No activity for >${STALL_WARN_MS / 1000}s` });
      } else if (elapsed <= STALL_WARN_MS && t.stalled) {
        updateTask(t.id, { stalled: 0 });
      }
    }
  }

  tasks = listTasksForJob(jobId);
  for (const t of tasks) {
    if (t.status === "blocked" && schedulable(t)) {
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
    if (t.status === "queued" && schedulable(t) && depsSatisfied(t, byIdReady)) {
      updateTask(t.id, { status: "ready", next_action: "launch" });
    }
  }

  tasks = listTasksForJob(jobId);
  const running = tasks.filter((t) => t.status === "running" && schedulable(t));
  let slots = MAX_PARALLEL - running.length;
  if (slots <= 0) return;

  const ready = tasks
    .filter((t) => t.status === "ready" && schedulable(t))
    .sort((a, b) => b.priority - a.priority || a.id - b.id);

  for (const t of ready) {
    if (slots <= 0) break;
    updateTask(t.id, { status: "running", current_action: "worker_start", last_activity_at: new Date().toISOString() });
    hooks.onStartWorker(t.id);
    slots -= 1;
  }

  tasks = listTasksForJob(jobId);
  const terminalStatus = terminalJobState(tasks);
  if (job.status === "running" && terminalStatus) {
    updateJob(jobId, { status: terminalStatus });
    insertEvent({
      job_id: jobId,
      task_id: null,
      level: terminalStatus === "failed" ? "error" : "info",
      type: terminalStatus === "failed" ? "job_failed" : "job_completed",
      message: terminalStatus === "failed"
        ? `Job failed: ${tasks.filter((t) => t.status === "failed").map((t) => t.role).join(", ")} failed`
        : "All tasks completed",
    });
  }
}

export { depsSatisfied };
