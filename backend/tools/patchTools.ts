import { mkdirSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
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
    assertPathInScope(ctx, args.path);
    const full = assertUnderWorktree(ctx.worktreePath, args.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, args.content, "utf8");
    return { ok: true, data: { path: args.path } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolApplyPatch(ctx: ToolContext, args: { diff?: string; patch?: string }): ToolResult {
  if (!ctx.worktreePath) return { ok: false, error: "No worktree — patch forbidden" };
  try {
    const diff = typeof args.diff === "string" && args.diff.trim()
      ? args.diff
      : typeof args.patch === "string" && args.patch.trim()
        ? args.patch
        : "";
    if (!diff) {
      return { ok: false, error: "apply_patch requires a non-empty diff or patch string" };
    }
    for (const file of extractPatchFiles(diff)) {
      assertPathInScope(ctx, file);
    }
    const patchFile = join(ctx.worktreePath, ".grist_patch.diff");
    writeFileSync(patchFile, diff, "utf8");
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

function matchesGlob(pattern: string, path: string): boolean {
  if (pattern === "**/*" || pattern === "**" || pattern === "*") return true;
  if (pattern.endsWith("/**") || pattern.endsWith("/**/*")) {
    const prefix = pattern.replace(/\/\*\*(?:\/\*)?$/, "");
    return path.startsWith(prefix + "/") || path === prefix;
  }
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
    return re.test(path);
  }
  return path === pattern;
}

function assertPathInScope(ctx: ToolContext, relPath: string): void {
  const scopeFiles = ctx.scopeFiles?.map(normalizeRelativePath).filter(Boolean);
  if (!scopeFiles || scopeFiles.length === 0) return;
  const candidate = normalizeRelativePath(relPath);
  if (scopeFiles.some((pattern) => matchesGlob(pattern, candidate))) return;
  throw new Error(`Write outside task scope: ${relPath} (allowed: ${scopeFiles.join(", ")})`);
}

function normalizeRelativePath(relPath: string): string {
  return normalize(relPath).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

function extractPatchFiles(diff: string): string[] {
  return Array.from(
    new Set([
      ...Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm), (m) => normalizeRelativePath(m[1])),
      ...Array.from(diff.matchAll(/^\+\+\+ b\/(.+)$/gm), (m) => normalizeRelativePath(m[1])),
      ...Array.from(diff.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm), (m) => normalizeRelativePath(m[1])),
    ]),
  );
}
