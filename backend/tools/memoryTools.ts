import type { ToolContext, ToolResult } from "./toolTypes.js";
import {
  writeHomeMemoryFile,
  writeRepoMemoryFile,
  readHomeSummary,
  readRepoSummary,
  listHomeMemoryFiles,
  listRepoMemoryFiles,
  readHomeMemoryFile,
  readRepoMemoryFile,
  collectMemoryContext,
} from "../memory/memoryManager.js";

/**
 * write_memory — agents call this to persist learnings.
 * scope: "project" (repo-local) or "global" (home ~/.grist).
 */
export function toolWriteMemory(
  ctx: ToolContext,
  args: { content: string; scope?: string; title?: string },
): ToolResult {
  const { content, scope = "project", title } = args;
  if (!content?.trim()) return { ok: false, error: "content is required" };

  const taskName = title || `task-${ctx.taskId}`;
  const scopes = scope === "both" ? ["project", "global"] : [scope];
  const written: string[] = [];

  for (const s of scopes) {
    if (s === "global") {
      const path = writeHomeMemoryFile(taskName, content);
      written.push(`global: ${path}`);
    } else {
      const path = writeRepoMemoryFile(ctx.repoPath, taskName, content);
      written.push(`project: ${path}`);
    }
  }

  return { ok: true, data: { written } };
}

/**
 * read_memory — agents read summaries and recent memory files.
 */
export function toolReadMemory(
  ctx: ToolContext,
  args: { scope?: string; file?: string },
): ToolResult {
  const { scope = "all", file } = args;

  if (file) {
    const content = scope === "global"
      ? readHomeMemoryFile(file)
      : readRepoMemoryFile(ctx.repoPath, file);
    return { ok: true, data: { file, content } };
  }

  if (scope === "all") {
    return { ok: true, data: { context: collectMemoryContext(ctx.repoPath) } };
  }

  if (scope === "global") {
    return {
      ok: true,
      data: {
        summary: readHomeSummary(),
        files: listHomeMemoryFiles(),
      },
    };
  }

  return {
    ok: true,
    data: {
      summary: readRepoSummary(ctx.repoPath),
      files: listRepoMemoryFiles(ctx.repoPath),
    },
  };
}
