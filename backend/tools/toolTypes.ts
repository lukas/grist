import type { TaskRuntimeState } from "../runtime/taskRuntime.js";

export interface ToolEmit {
  (level: "info" | "warn" | "error", type: string, message: string, data?: unknown): void;
}

export interface ToolContext {
  jobId: number;
  taskId: number;
  repoPath: string;
  worktreePath: string | null;
  scopeFiles?: string[];
  scopeJson?: string;
  scratchpadPath: string;
  appWorkspaceRoot: string;
  allowedToolNames: string[];
  commandAllowlist: string[];
  commandEnv?: Record<string, string>;
  runtime?: TaskRuntimeState;
  emit: ToolEmit;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
