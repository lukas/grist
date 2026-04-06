import { join } from "node:path";

/** App-managed root: ~/.swarm_operator (or overridden). */
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
