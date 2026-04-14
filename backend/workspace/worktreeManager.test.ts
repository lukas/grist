import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createWorktree, syncWorktreeToRepo } from "./worktreeManager.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Grist Test",
      GIT_AUTHOR_EMAIL: "grist-test@example.com",
      GIT_COMMITTER_NAME: "Grist Test",
      GIT_COMMITTER_EMAIL: "grist-test@example.com",
    },
  });
  expect(result.status).toBe(0);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncWorktreeToRepo", () => {
  it("copies files from commits made in the worktree branch", () => {
    const repoRoot = makeTempDir("grist-repo-");
    const worktreePath = join(repoRoot, "..", `${Date.now()}-wt`);
    tempDirs.push(worktreePath);

    runGit(repoRoot, ["init", "-b", "main"]);
    writeFileSync(join(repoRoot, ".gitignore"), ".grist\n");
    runGit(repoRoot, ["add", ".gitignore"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);

    const created = createWorktree(repoRoot, worktreePath, "HEAD", "feature");
    expect(created.ok).toBe(true);

    writeFileSync(join(worktreePath, "README.md"), "# Chess\n");
    runGit(worktreePath, ["add", "README.md"]);
    runGit(worktreePath, ["commit", "-m", "add readme"]);

    const synced = syncWorktreeToRepo(repoRoot, worktreePath);

    expect(synced.ok).toBe(true);
    expect(synced.copied).toContain("README.md");
    expect(existsSync(join(repoRoot, "README.md"))).toBe(true);
    expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toContain("# Chess");
  });
});
