/** Spec §5 enums as string unions for SQLite storage. */

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

export type ArtifactType =
  | "findings_report"
  | "reducer_summary"
  | "hypothesis_list"
  | "candidate_patch"
  | "verification_result"
  | "file_map"
  | "final_summary";

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
