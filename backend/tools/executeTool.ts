import type { ToolContext, ToolResult } from "./toolTypes.js";
import {
  toolListChangedFiles,
  toolGrepCode,
  toolListFiles,
  toolReadFile,
  toolReadGitHistory,
} from "./repoTools.js";
import { toolReadArtifacts, toolWriteArtifact } from "./artifactTools.js";
import { toolAppendScratchpad, toolReadScratchpad, toolWriteScratchpad } from "./scratchpadTools.js";
import { toolRunCommandSafe, toolRunCommandBg, toolPollCommand, toolRunLint, toolRunTests } from "./executionTools.js";
import {
  toolApplyPatch,
  toolCreateWorktree,
  toolGetWorktreeDiff,
  toolRemoveWorktree,
  toolWriteFile,
} from "./patchTools.js";
import { toolEmitProgress, toolPauseSelf, toolAskUser } from "./controlTools.js";
import { toolWriteMemory, toolReadMemory } from "./memoryTools.js";
import { toolListSkills, toolReadSkill } from "./skillTools.js";
import { toolSpawnSubtask, toolPollSubtask } from "./subtaskTools.js";

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  if (!ctx.allowedToolNames.includes(name)) {
    return { ok: false, error: `Tool not allowed for task: ${name}` };
  }

  switch (name) {
    case "list_files":
      return toolListFiles(ctx, args as { path?: string; recursive?: boolean });
    case "grep_code":
      return toolGrepCode(ctx, args as { pattern: string; scopePaths?: string[] });
    case "read_file":
      return toolReadFile(ctx, args as { path: string; startLine?: number; endLine?: number });
    case "read_git_history":
      return toolReadGitHistory(ctx, args as { path?: string; limit?: number });
    case "list_changed_files":
      return toolListChangedFiles(ctx, args as { revRange?: string });
    case "read_artifacts":
      return toolReadArtifacts(ctx, args as { taskIds?: number[] });
    case "write_artifact":
      return toolWriteArtifact(ctx, args as { type: string; content: unknown; confidence?: number });
    case "read_scratchpad":
      return toolReadScratchpad(ctx);
    case "write_scratchpad":
      return toolWriteScratchpad(ctx, args as { content: string });
    case "append_scratchpad":
      return toolAppendScratchpad(ctx, args as { content: string });
    case "run_tests":
      return toolRunTests(ctx, args as { command?: string; target?: string }, abortSignal);
    case "run_lint":
      return toolRunLint(ctx, args as { command?: string }, abortSignal);
    case "run_command_safe":
      return toolRunCommandSafe(ctx, args as { command: string; cwd?: string; timeoutMs?: number }, abortSignal);
    case "run_command_bg":
      return toolRunCommandBg(ctx, args as { command: string; cwd?: string; timeoutMs?: number });
    case "poll_command":
      return toolPollCommand(ctx, args as { command_id: string });
    case "create_worktree":
      return toolCreateWorktree(ctx, args as { baseRef: string; branchName: string; path?: string });
    case "write_file":
      return toolWriteFile(ctx, args as { path: string; content: string });
    case "apply_patch":
      return toolApplyPatch(ctx, args as { diff: string });
    case "get_worktree_diff":
      return toolGetWorktreeDiff(ctx);
    case "remove_worktree":
      return toolRemoveWorktree(ctx);
    case "emit_progress_event":
      return toolEmitProgress(ctx, args as { message: string; data?: unknown });
    case "pause_self":
      return toolPauseSelf(ctx, args as { reason?: string });
    case "write_memory":
      return toolWriteMemory(ctx, args as { content: string; scope?: string; title?: string });
    case "read_memory":
      return toolReadMemory(ctx, args as { scope?: string; file?: string });
    case "list_skills":
      return toolListSkills(ctx, args as { scope?: "visible" | "global" | "project" | "all" });
    case "read_skill":
      return toolReadSkill(ctx, args as { skillId: string; scope?: "global" | "project"; file?: string });
    case "ask_user":
      return toolAskUser(ctx, args as { question: string; options?: string[]; context?: string });
    case "spawn_subtask":
      return toolSpawnSubtask(ctx, args as { goal: string; files?: string[]; approach?: string });
    case "poll_subtask":
      return toolPollSubtask(ctx, args as { subtask_id: number });
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

export const ALL_TOOL_NAMES = [
  "list_files",
  "grep_code",
  "read_file",
  "read_git_history",
  "list_changed_files",
  "read_artifacts",
  "write_artifact",
  "read_scratchpad",
  "write_scratchpad",
  "append_scratchpad",
  "run_tests",
  "run_lint",
  "run_command_safe",
  "run_command_bg",
  "poll_command",
  "create_worktree",
  "write_file",
  "apply_patch",
  "get_worktree_diff",
  "remove_worktree",
  "emit_progress_event",
  "pause_self",
  "write_memory",
  "read_memory",
  "list_skills",
  "read_skill",
  "ask_user",
  "spawn_subtask",
  "poll_subtask",
] as const;
