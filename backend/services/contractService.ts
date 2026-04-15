import { getTask, listTasksForJob, type TaskRow } from "../db/taskRepo.js";
import {
  EpisodeContractSchema,
  ManagerPlanSchema,
  normalizeWorkerPacket,
  type EpisodeContract,
  type ManagerPlan,
  type PlannedWorkerTask,
  type WorkerPacket,
} from "../types/taskState.js";

const GLOBAL_PATH_PATTERNS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  ".gitignore",
  "README.md",
  ".cursor/",
  ".github/",
];

export type ContractViolationSeverity = "minor" | "major";

export interface ContractViolation {
  severity: ContractViolationSeverity;
  violatingFiles: string[];
  ownedFiles: string[];
  reason: string;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function globMatches(pattern: string, candidate: string): boolean {
  const p = normalizePath(pattern);
  const c = normalizePath(candidate);
  if (p === "**/*" || p === "*") return true;
  if (p.endsWith("/**")) return c === p.slice(0, -3) || c.startsWith(`${p.slice(0, -3)}/`);
  if (p.endsWith("/*")) {
    const prefix = p.slice(0, -1);
    return c.startsWith(prefix) && !c.slice(prefix.length).includes("/");
  }
  return p === c;
}

function pathIsOwned(path: string, ownedFiles: string[]): boolean {
  if (ownedFiles.length === 0) return true;
  return ownedFiles.some((owned) => globMatches(owned, path));
}

function isGlobalPath(path: string): boolean {
  return GLOBAL_PATH_PATTERNS.some((pattern) => globMatches(pattern, path) || path.startsWith(pattern));
}

function sharesTopLevelArea(path: string, ownedFiles: string[]): boolean {
  const topLevel = normalizePath(path).split("/")[0] || "";
  if (!topLevel) return false;
  return ownedFiles.some((owned) => (normalizePath(owned).split("/")[0] || "") === topLevel);
}

function roleDefaultOutputs(role: PlannedWorkerTask["role"]): string[] {
  switch (role) {
    case "scout":
      return ["findings_report"];
    case "implementer":
      return ["candidate_patch"];
    case "reviewer":
      return ["review_report"];
    case "verifier":
      return ["verification_result"];
    case "summarizer":
      return ["final_summary"];
  }
}

export function parseWorkerPacket(scopeJson: string, role?: PlannedWorkerTask["role"]): WorkerPacket {
  try {
    return normalizeWorkerPacket(JSON.parse(scopeJson || "{}"), role);
  } catch {
    return normalizeWorkerPacket({}, role);
  }
}

export function normalizePlannedTask(task: PlannedWorkerTask): PlannedWorkerTask {
  const normalizedPacket = normalizeWorkerPacket(task.packet || {}, task.role);
  return ManagerPlanSchema.shape.tasks.element.parse({
    ...task,
    packet: normalizedPacket,
  });
}

export function normalizePlanContracts(plan: ManagerPlan): ManagerPlan {
  const parsed = ManagerPlanSchema.parse(plan);
  return {
    ...parsed,
    tasks: parsed.tasks.map(normalizePlannedTask),
  };
}

export function validatePlanContracts(plan: ManagerPlan): { ok: true; plan: ManagerPlan } | { ok: false; reason: string } {
  const normalized = normalizePlanContracts(plan);
  for (let i = 0; i < normalized.tasks.length; i++) {
    const task = normalized.tasks[i];
    const contract = EpisodeContractSchema.parse(task.packet.contract_json);
    if (task.role === "implementer" && contract.file_ownership.length === 0) {
      return { ok: false, reason: `Task ${i} is missing file ownership` };
    }
    const depOutputs = new Set<string>();
    for (const dep of task.depends_on || []) {
      const depTask = normalized.tasks[dep];
      if (!depTask) {
        return { ok: false, reason: `Task ${i} depends on missing task index ${dep}` };
      }
      const outputs = depTask.packet.contract_json.outputs?.length
        ? depTask.packet.contract_json.outputs
        : roleDefaultOutputs(depTask.role);
      for (const output of outputs) depOutputs.add(output);
    }
    for (const input of contract.inputs) {
      if ((task.depends_on || []).length === 0) continue;
      if (!depOutputs.has(input)) {
        return { ok: false, reason: `Task ${i} requires input "${input}" not produced by its dependencies` };
      }
    }
  }
  return { ok: true, plan: normalized };
}

export function classifyContractViolation(ownedFiles: string[], touchedFiles: string[]): ContractViolation | null {
  const normalizedOwned = ownedFiles.map(normalizePath).filter(Boolean);
  const violatingFiles = touchedFiles.map(normalizePath).filter((file) => !pathIsOwned(file, normalizedOwned));
  if (violatingFiles.length === 0) return null;
  const severity: ContractViolationSeverity = violatingFiles.some((file) => isGlobalPath(file) || !sharesTopLevelArea(file, normalizedOwned))
    ? "major"
    : "minor";
  return {
    severity,
    violatingFiles,
    ownedFiles: normalizedOwned,
    reason: severity === "major"
      ? "Touched files outside declared ownership and crossed a shared/global boundary."
      : "Touched files outside declared ownership but stayed within the same narrow feature area.",
  };
}

export function extractViolationFromToolError(error: string, ownedFiles: string[]): ContractViolation | null {
  const match = error.match(/Write outside task scope: ([^ ]+)/);
  if (!match) return null;
  return classifyContractViolation(ownedFiles, [match[1]]);
}

export function canSafelyForkTask(taskId: number, newPacket: WorkerPacket): { ok: true } | { ok: false; reason: string } {
  const task = getTask(taskId);
  if (!task) return { ok: false, reason: "Task not found" };
  const proposedOwnership = newPacket.contract_json.file_ownership;
  if (proposedOwnership.length === 0) return { ok: false, reason: "Forked task must declare file ownership" };
  const peers = listTasksForJob(task.job_id).filter((candidate) =>
    candidate.id !== taskId
    && candidate.role === "implementer"
    && ["queued", "ready", "running", "blocked", "paused"].includes(candidate.status)
  );
  for (const peer of peers) {
    const peerPacket = parseWorkerPacket(peer.scope_json, "implementer");
    const overlap = proposedOwnership.some((owned) =>
      peerPacket.contract_json.file_ownership.some((peerOwned) => globMatches(owned, peerOwned) || globMatches(peerOwned, owned))
    );
    if (overlap) {
      return { ok: false, reason: `Proposed file ownership overlaps with active implementer task ${peer.id}` };
    }
  }
  return { ok: true };
}

export function taskContract(task: TaskRow): EpisodeContract {
  return parseWorkerPacket(task.scope_json, task.role as PlannedWorkerTask["role"]).contract_json;
}
