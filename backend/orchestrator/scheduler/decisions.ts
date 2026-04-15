import { listArtifactsForTasks } from "../../db/artifactRepo.js";
import type { TaskRow } from "../../db/taskRepo.js";
import { computeMaxParallelWorkers } from "../parallelism.js";

export function getMaxParallelWorkers(): number {
  return computeMaxParallelWorkers();
}

export const MAX_PARALLEL_WORKERS = 4;
const NON_SCHEDULABLE_KINDS = new Set(["root", "planner"]);

export function schedulable(task: TaskRow): boolean {
  return !NON_SCHEDULABLE_KINDS.has(task.kind);
}

export function depsSatisfied(task: TaskRow, byId: Map<number, TaskRow>): boolean {
  const deps = JSON.parse(task.dependencies_json || "[]") as number[];
  if (deps.length === 0) return true;
  const terminal = new Set(["done", "completed", "failed", "stopped", "superseded"]);
  return deps.every((id) => {
    const dependency = byId.get(id);
    return dependency != null && terminal.has(dependency.status);
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
  const terminal = new Set(["done", "completed", "failed", "stopped", "superseded"]);
  return deps.every((id) => {
    const dep = byId.get(id);
    if (!dep || !terminal.has(dep.status)) return false;
    if (!["done", "completed"].includes(dep.status)) return true;
    if (!dep.artifact_type) return true;
    return artifactsByTaskId.get(id)?.has(dep.artifact_type) === true;
  });
}

export function reducerCanRun(jobId: number, task: TaskRow, tasks: TaskRow[], byId: Map<number, TaskRow>): boolean {
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

function hasPassingDescendantVerifier(taskId: number, byParent: Map<number, TaskRow[]>, passedByTaskId: Map<number, boolean>): boolean {
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
  tasks: TaskRow[],
): { status: "completed" | "failed" | null; softFailedTaskIds: number[] } {
  const work = tasks.filter(schedulable);
  if (work.length === 0) return { status: null, softFailedTaskIds: [] };
  const active = work.filter((task) => ["queued", "ready", "running", "blocked", "paused"].includes(task.status));
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
