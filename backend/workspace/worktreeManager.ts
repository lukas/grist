import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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

const TRANSIENT_PATH_PREFIXES = ["node_modules/", "dist/", ".git/", ".grist/"];

function isSyncablePath(path: string): boolean {
  return path !== "" && !TRANSIENT_PATH_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

function gitLines(worktreePath: string, args: string[]): { ok: boolean; lines: string[]; stderr: string } {
  const r = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    return { ok: false, lines: [], stderr: (r.stderr || r.stdout || "git command failed").toString() };
  }
  const lines = (r.stdout || "")
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, lines, stderr: "" };
}

function getTrackedChanges(worktreePath: string): { ok: boolean; copy: string[]; remove: string[]; stderr: string } {
  const res = gitLines(worktreePath, ["diff", "--name-status", "HEAD"]);
  if (!res.ok) return { ok: false, copy: [], remove: [], stderr: res.stderr };
  const copy = new Set<string>();
  const remove = new Set<string>();
  for (const line of res.lines) {
    const parts = line.split("\t").filter(Boolean);
    const status = parts[0] || "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[1] || "";
      const newPath = parts[2] || "";
      if (isSyncablePath(oldPath)) remove.add(oldPath);
      if (isSyncablePath(newPath)) copy.add(newPath);
      continue;
    }
    const filePath = parts[1] || "";
    if (!isSyncablePath(filePath)) continue;
    if (status.startsWith("D")) remove.add(filePath);
    else copy.add(filePath);
  }
  return { ok: true, copy: Array.from(copy), remove: Array.from(remove), stderr: "" };
}

function getUntrackedChanges(worktreePath: string): { ok: boolean; files: string[]; stderr: string } {
  const res = gitLines(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  if (!res.ok) return { ok: false, files: [], stderr: res.stderr };
  return {
    ok: true,
    files: res.lines.filter(isSyncablePath),
    stderr: "",
  };
}

export function syncWorktreeToRepo(
  repoRoot: string,
  worktreePath: string
): { ok: boolean; copied: string[]; removed: string[]; skipped: string[]; stderr: string } {
  const tracked = getTrackedChanges(worktreePath);
  if (!tracked.ok) {
    return { ok: false, copied: [], removed: [], skipped: [], stderr: tracked.stderr };
  }
  const untracked = getUntrackedChanges(worktreePath);
  if (!untracked.ok) {
    return { ok: false, copied: [], removed: [], skipped: [], stderr: untracked.stderr };
  }

  const copied: string[] = [];
  const removed: string[] = [];
  const skipped = Array.from(new Set([...tracked.copy, ...tracked.remove, ...untracked.files].filter((path) => !isSyncablePath(path))));
  const filesToCopy = Array.from(new Set([...tracked.copy, ...untracked.files]));

  try {
    for (const relativePath of filesToCopy) {
      const src = join(worktreePath, relativePath);
      const dest = join(repoRoot, relativePath);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      copied.push(relativePath);
    }
    for (const relativePath of tracked.remove) {
      const dest = join(repoRoot, relativePath);
      if (!existsSync(dest)) continue;
      rmSync(dest, { force: true, recursive: true });
      removed.push(relativePath);
    }
  } catch (error) {
    return {
      ok: false,
      copied,
      removed,
      skipped,
      stderr: String(error),
    };
  }

  return { ok: true, copied, removed, skipped, stderr: "" };
}
