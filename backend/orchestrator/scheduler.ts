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
  const terminal = new Set(["done", "completed", "failed", "stopped"]);
  return deps.every((id) => {
    const s = byId.get(id)?.status;
    return s != null && terminal.has(s);
  });
}

function schedulable(t: TaskRow): boolean {
  return !NON_SCHEDULABLE_KINDS.has(t.kind);
}

function hasSuccessfulDelivery(tasks: TaskRow[]): boolean {
  const work = tasks.filter(schedulable);
  const implementers = work.filter((task) => task.role === "implementer");
  if (implementers.length > 0) return implementers.some((task) => task.status === "done");
  return work.some((task) => task.role !== "summarizer" && task.status === "done");
}

function isSoftFailure(task: TaskRow, tasks: TaskRow[]): boolean {
  if (task.role === "summarizer" || task.role === "verifier") {
    return hasSuccessfulDelivery(tasks);
  }
  if ((task.role === "scout" || task.role === "reviewer") && tasks.some((candidate) => candidate.role === "implementer" && candidate.status === "done")) {
    return true;
  }
  return false;
}

export function terminalJobOutcome(tasks: TaskRow[]): { status: "completed" | "failed" | null; softFailedTaskIds: number[] } {
  const work = tasks.filter(schedulable);
  if (work.length === 0) return { status: null, softFailedTaskIds: [] };
  const active = work.filter((t) =>
    ["queued", "ready", "running", "blocked", "paused"].includes(t.status)
  );
  if (active.length > 0) return { status: null, softFailedTaskIds: [] };
  const failed = work.filter((task) => task.status === "failed");
  if (failed.length === 0) return { status: "completed", softFailedTaskIds: [] };
  const softFailed = failed.filter((task) => isSoftFailure(task, work));
  const criticalFailed = failed.filter((task) => !isSoftFailure(task, work));
  return {
    status: criticalFailed.length > 0 ? "failed" : "completed",
    softFailedTaskIds: softFailed.map((task) => task.id),
  };
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
  const terminal = terminalJobOutcome(tasks);
  if (job.status === "running" && terminal.status) {
    updateJob(jobId, { status: terminal.status });
    const softFailed = tasks.filter((task) => terminal.softFailedTaskIds.includes(task.id));
    insertEvent({
      job_id: jobId,
      task_id: null,
      level: terminal.status === "failed" ? "error" : softFailed.length > 0 ? "warn" : "info",
      type: terminal.status === "failed"
        ? "job_failed"
        : softFailed.length > 0
          ? "job_completed_with_warnings"
          : "job_completed",
      message: terminal.status === "failed"
        ? `Job failed: ${tasks.filter((t) => t.status === "failed").map((t) => t.role).join(", ")} failed`
        : softFailed.length > 0
          ? `Job completed with warnings: ${softFailed.map((task) => task.role).join(", ")} failed but core delivery succeeded`
          : "All tasks completed",
    });
  }
}

export { depsSatisfied };
