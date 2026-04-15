import { cpus, freemem, totalmem } from "node:os";
import { loadAppSettings } from "../settings/appSettings.js";
import { totalRemoteSlots } from "../workers/workerPool.js";

const MIN_WORKERS = 2;
const MAX_WORKERS_CAP = 12;
const MEMORY_PER_WORKER_MB = 512;

export type UrgencyLevel = "low" | "normal" | "high" | "max";

function urgencyMultiplier(urgency: UrgencyLevel): number {
  switch (urgency) {
    case "low": return 0.5;
    case "normal": return 1.0;
    case "high": return 1.5;
    case "max": return 2.0;
  }
}

export function computeMaxParallelWorkers(urgencyOverride?: UrgencyLevel): number {
  const settings = loadAppSettings();
  const urgency: UrgencyLevel = urgencyOverride || (settings as Record<string, unknown>).urgency as UrgencyLevel || "normal";

  // Workers are I/O-bound (waiting for LLM API responses), so allow one per 2 CPU cores
  const numCpus = cpus().length;
  const cpuLimit = Math.max(MIN_WORKERS, Math.floor(numCpus / 2));

  // Each worker maintains conversation history in memory
  const freeMemMb = freemem() / (1024 * 1024);
  const memLimit = Math.max(MIN_WORKERS, Math.floor(freeMemMb / MEMORY_PER_WORKER_MB));

  const resourceLimit = Math.min(cpuLimit, memLimit);
  const remoteSlots = totalRemoteSlots();
  const localAdjusted = Math.round(resourceLimit * urgencyMultiplier(urgency));
  const total = localAdjusted + remoteSlots;

  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS_CAP + remoteSlots, total));
}

export function describeParallelismPolicy(): {
  maxWorkers: number;
  cpuCores: number;
  freeMemMb: number;
  totalMemMb: number;
  urgency: string;
} {
  const numCpus = cpus().length;
  const freeMemMb = Math.round(freemem() / (1024 * 1024));
  const totalMemMb = Math.round(totalmem() / (1024 * 1024));
  const maxWorkers = computeMaxParallelWorkers();
  const settings = loadAppSettings();
  const urgency = (settings as Record<string, unknown>).urgency as string || "normal";
  return { maxWorkers, cpuCores: numCpus, freeMemMb, totalMemMb, urgency };
}
