import { join } from "node:path";

/** App-managed workspace root (default under Electron userData; override via settings). */
export function jobRoot(appWorkspaceRoot: string, jobId: number): string {
  return join(appWorkspaceRoot, "jobs", String(jobId));
}

export function taskDir(appWorkspaceRoot: string, jobId: number, taskId: number): string {
  return join(jobRoot(appWorkspaceRoot, jobId), "tasks", String(taskId));
}

export function scratchpadPath(appWorkspaceRoot: string, jobId: number, taskId: number): string {
  return join(taskDir(appWorkspaceRoot, jobId, taskId), "scratchpad.md");
}

export function worktreesRoot(appWorkspaceRoot: string, jobId: number): string {
  return join(jobRoot(appWorkspaceRoot, jobId), "worktrees");
}

export function defaultWorktreePath(appWorkspaceRoot: string, jobId: number, taskId: number): string {
  return join(worktreesRoot(appWorkspaceRoot, jobId), `task-${taskId}`);
}
