import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createWorktree(repoRoot: string, worktreePath: string, baseRef: string, branchName: string): { ok: boolean; stderr: string } {
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (existsSync(worktreePath)) {
    return { ok: false, stderr: `worktree path already exists: ${worktreePath}` };
  }
  const r = spawnSync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, baseRef],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000 }
  );
  if (r.status !== 0) {
    return { ok: false, stderr: (r.stderr || r.stdout || "git worktree failed").toString() };
  }
  return { ok: true, stderr: "" };
}

export function removeWorktree(repoRoot: string, worktreePath: string): { ok: boolean; stderr: string } {
  const r = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) {
    return { ok: false, stderr: (r.stderr || r.stdout || "git worktree remove failed").toString() };
  }
  return { ok: true, stderr: "" };
}

export function getWorktreeDiff(repoRoot: string, worktreePath: string): { ok: boolean; diff: string; stderr: string } {
  const r = spawnSync("git", ["-C", worktreePath, "diff", "HEAD"], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0 && r.stdout === "") {
    return { ok: false, diff: "", stderr: (r.stderr || "git diff failed").toString() };
  }
  return { ok: true, diff: (r.stdout || "").toString(), stderr: (r.stderr || "").toString() };
}
