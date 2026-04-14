import { listTasksForJob, updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { getJob, updateJob } from "../db/jobRepo.js";
import { listArtifactsForTasks } from "../db/artifactRepo.js";

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

function artifactTypesByTaskId(jobId: number, taskIds: number[]): Map<number, Set<string>> {
  const rows = listArtifactsForTasks(jobId, taskIds) as Array<{ task_id: number | null; type: string }>;
  const byTaskId = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.task_id == null) continue;
    const types = byTaskId.get(row.task_id) || new Set<string>();
    types.add(row.type);
    byTaskId.set(row.task_id, types);
  }
  return byTaskId;
}

function reducerDepsSatisfied(
  task: TaskRow,
  byId: Map<number, TaskRow>,
  artifactsByTaskId: Map<number, Set<string>>,
): boolean {
  const deps = JSON.parse(task.dependencies_json || "[]") as number[];
  if (deps.length === 0) return true;
  const terminal = new Set(["done", "completed", "failed", "stopped"]);
  return deps.every((id) => {
    const dep = byId.get(id);
    if (!dep || !terminal.has(dep.status)) return false;
    if (!["done", "completed"].includes(dep.status)) return true;
    if (!dep.artifact_type) return true;
    return artifactsByTaskId.get(id)?.has(dep.artifact_type) === true;
  });
}

function reducerCanRun(jobId: number, task: TaskRow, tasks: TaskRow[], byId: Map<number, TaskRow>): boolean {
  const otherActiveWork = tasks.some((candidate) =>
    candidate.id !== task.id
    && schedulable(candidate)
    && candidate.kind !== "reducer"
    && ["queued", "ready", "running", "blocked", "paused"].includes(candidate.status)
  );
  if (otherActiveWork) return false;
  const depIds = JSON.parse(task.dependencies_json || "[]") as number[];
  const artifacts = artifactTypesByTaskId(jobId, depIds);
  return reducerDepsSatisfied(task, byId, artifacts);
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

function verifierPassedByTaskId(jobId: number, tasks: TaskRow[]): Map<number, boolean> {
  const verifierIds = tasks.filter((task) => task.role === "verifier").map((task) => task.id);
  const artifacts = listArtifactsForTasks(jobId, verifierIds) as Array<{
    task_id: number | null;
    type: string;
    content_json: string;
  }>;
  const latest = new Map<number, boolean>();
  for (const artifact of artifacts) {
    if (artifact.type !== "verification_result" || artifact.task_id == null) continue;
    try {
      const parsed = JSON.parse(artifact.content_json) as { passed?: unknown };
      latest.set(artifact.task_id, parsed.passed === true);
    } catch {
      latest.set(artifact.task_id, false);
    }
  }
  return latest;
}

function childMap(tasks: TaskRow[]): Map<number, TaskRow[]> {
  const map = new Map<number, TaskRow[]>();
  for (const task of tasks) {
    if (task.parent_task_id == null) continue;
    const arr = map.get(task.parent_task_id) || [];
    arr.push(task);
    map.set(task.parent_task_id, arr);
  }
  return map;
}

function hasDescendantImplementer(taskId: number, byParent: Map<number, TaskRow[]>): boolean {
  const stack = [...(byParent.get(taskId) || [])];
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.role === "implementer") return true;
    stack.push(...(byParent.get(task.id) || []));
  }
  return false;
}

function hasPassingDescendantVerifier(
  taskId: number,
  byParent: Map<number, TaskRow[]>,
  passedByTaskId: Map<number, boolean>
): boolean {
  const stack = [...(byParent.get(taskId) || [])];
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.role === "verifier" && passedByTaskId.get(task.id) === true) return true;
    stack.push(...(byParent.get(task.id) || []));
  }
  return false;
}

function unresolvedVerifierFailureTaskIds(jobId: number, tasks: TaskRow[]): number[] {
  const byParent = childMap(tasks);
  const passedByTaskId = verifierPassedByTaskId(jobId, tasks);
  return tasks
    .filter((task) => task.role === "verifier" && passedByTaskId.get(task.id) === false)
    .filter((task) => !hasPassingDescendantVerifier(task.id, byParent, passedByTaskId))
    .filter((task) => !hasDescendantImplementer(task.id, byParent))
    .map((task) => task.id);
}

export function terminalJobOutcome(
  jobId: number,
  tasks: TaskRow[]
): { status: "completed" | "failed" | null; softFailedTaskIds: number[] } {
  const work = tasks.filter(schedulable);
  if (work.length === 0) return { status: null, softFailedTaskIds: [] };
  const active = work.filter((t) =>
    ["queued", "ready", "running", "blocked", "paused"].includes(t.status)
  );
  if (active.length > 0) return { status: null, softFailedTaskIds: [] };
  const unresolvedVerifierIds = unresolvedVerifierFailureTaskIds(jobId, work);
  if (unresolvedVerifierIds.length > 0) {
    return { status: "failed", softFailedTaskIds: [] };
  }
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
      const ready = t.kind === "reducer"
        ? reducerCanRun(jobId, t, listTasksForJob(jobId), m)
        : depsSatisfied(t, m);
      if (ready) {
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
    const ready = t.kind === "reducer"
      ? reducerCanRun(jobId, t, tasks, byIdReady)
      : depsSatisfied(t, byIdReady);
    if (t.status === "queued" && schedulable(t) && ready) {
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
  const terminal = terminalJobOutcome(jobId, tasks);
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
