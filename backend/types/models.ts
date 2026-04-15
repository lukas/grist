/** Spec §5 enums as string unions for SQLite storage. */

export const TASK_ROLES = [
  "root",
  "manager",
  "scout",
  "implementer",
  "verifier",
  "reviewer",
  "summarizer",
] as const;

export type TaskRole = (typeof TASK_ROLES)[number];

export const WORKER_ROLES = [
  "scout",
  "implementer",
  "verifier",
  "reviewer",
  "summarizer",
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export type JobStatus =
  | "draft"
  | "planning"
  | "running"
  | "paused"
  | "reducing"
  | "verifying"
  | "completed"
  | "failed"
  | "stopped";

export type TaskStatus =
  | "queued"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "failed"
  | "blocked"
  | "done"
  | "superseded";

export type TaskKind =
  | "root"
  | "planner"
  | "analysis"
  | "reducer"
  | "verifier"
  | "patch_writer"
  | "patch_integrator";

export type WriteMode = "none" | "worktree";

export type WorkspaceRepoMode = "shared_read_only" | "isolated_worktree";

export const ARTIFACT_TYPES = [
  "manager_plan",
  "findings_report",
  "review_report",
  "reducer_summary",
  "hypothesis_list",
  "candidate_patch",
  "verification_result",
  "contract_violation",
  "file_map",
  "final_summary",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export type ModelProviderName = "claude" | "codex" | "kimi" | "mock";

export interface ModelRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema?: Record<string, unknown>;
  modelName?: string;
  temperature?: number;
  maxTokens: number;
  metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  parsedJson?: unknown;
  raw: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  finishReason: string;
}

export interface ModelProvider {
  name: ModelProviderName;
  generateStructured(input: ModelRequest): Promise<ModelResponse>;
  generateText(input: ModelRequest): Promise<ModelResponse>;
  cancel?(requestId: string): Promise<void>;
}
