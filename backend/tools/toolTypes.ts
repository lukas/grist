export interface ToolEmit {
  (level: "info" | "warn" | "error", type: string, message: string, data?: unknown): void;
}

export interface ToolContext {
  jobId: number;
  taskId: number;
  repoPath: string;
  worktreePath: string | null;
  scratchpadPath: string;
  appWorkspaceRoot: string;
  allowedToolNames: string[];
  commandAllowlist: string[];
  emit: ToolEmit;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
