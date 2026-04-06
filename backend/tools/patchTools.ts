import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createWorktree, getWorktreeDiff, removeWorktree } from "../workspace/worktreeManager.js";
import { assertUnderWorktree } from "./pathGuard.js";
import type { ToolContext, ToolResult } from "./toolTypes.js";

export function toolCreateWorktree(
  ctx: ToolContext,
  args: { baseRef: string; branchName: string; path?: string }
): ToolResult {
  if (!ctx.worktreePath) {
    return { ok: false, error: "Task has no worktree_path set" };
  }
  const wt = args.path || ctx.worktreePath;
  const res = createWorktree(ctx.repoPath, wt, args.baseRef, args.branchName);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true, data: { worktreePath: wt } };
}

export function toolWriteFile(ctx: ToolContext, args: { path: string; content: string }): ToolResult {
  if (!ctx.worktreePath) return { ok: false, error: "No worktree — writes forbidden" };
  try {
    const full = assertUnderWorktree(ctx.worktreePath, args.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, args.content, "utf8");
    return { ok: true, data: { path: args.path } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolApplyPatch(ctx: ToolContext, args: { diff: string }): ToolResult {
  if (!ctx.worktreePath) return { ok: false, error: "No worktree — patch forbidden" };
  try {
    const patchFile = join(ctx.worktreePath, ".grist_patch.diff");
    writeFileSync(patchFile, args.diff, "utf8");
    const r = spawnSync("git", ["apply", patchFile], { cwd: ctx.worktreePath, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) {
      return { ok: false, error: r.stderr || r.stdout || "git apply failed" };
    }
    return { ok: true, data: { applied: true } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolGetWorktreeDiff(ctx: ToolContext): ToolResult {
  if (!ctx.worktreePath) return { ok: false, error: "No worktree" };
  const r = getWorktreeDiff(ctx.repoPath, ctx.worktreePath);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true, data: { diff: r.diff } };
}

export function toolRemoveWorktree(ctx: ToolContext): ToolResult {
  if (!ctx.worktreePath) return { ok: false, error: "No worktree" };
  const r = removeWorktree(ctx.repoPath, ctx.worktreePath);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true, data: { removed: true } };
}
