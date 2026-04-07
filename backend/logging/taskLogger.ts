import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
  timestamp: string;
  jobId: number;
  taskId: number;
  step: number;
  type: "prompt" | "response" | "tool_call" | "tool_result" | "error" | "info" | "auto_pause";
  data: unknown;
}

/** Resolve log dir for a given repo: <repo>/.grist/logs */
export function repoLogsDir(repoPath: string): string {
  return join(repoPath, ".grist", "logs");
}

function logFilePath(repoPath: string, jobId: number, taskId: number): string {
  const dir = join(repoLogsDir(repoPath), `job-${jobId}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `task-${taskId}.jsonl`);
}

export function appendTaskLog(repoPath: string, entry: LogEntry): void {
  if (!repoPath) return;
  try {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(logFilePath(repoPath, entry.jobId, entry.taskId), line);
  } catch {
    // best-effort; don't crash the worker
  }
}

export function readTaskLog(repoPath: string, jobId: number, taskId: number): string {
  const p = logFilePath(repoPath, jobId, taskId);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

/** Ensure the .grist directory exists and add .grist to .gitignore if not already there */
export function ensureGristDir(repoPath: string): void {
  const gristDir = join(repoPath, ".grist");
  mkdirSync(join(gristDir, "logs"), { recursive: true });

  const gitignorePath = join(repoPath, ".gitignore");
  try {
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (!content.split("\n").some((line) => line.trim() === ".grist")) {
      appendFileSync(gitignorePath, `${content.endsWith("\n") || !content ? "" : "\n"}.grist\n`);
    }
  } catch {
    // best-effort
  }
}
