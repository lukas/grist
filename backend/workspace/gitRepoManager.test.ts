import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureGitRepo,
  ensureHeadCommit,
  hasHeadCommit,
  isGitRepo,
} from "./gitRepoManager.js";

describe("gitRepoManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes a non-git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "grist-git-"));
    dirs.push(dir);
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");

    const result = ensureGitRepo(dir);
    expect(result.ok).toBe(true);
    expect(isGitRepo(dir)).toBe(true);
  });

  it("creates an initial commit when HEAD is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "grist-git-head-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.ts"), "export const x = 1;\n", "utf8");

    ensureGitRepo(dir);
    expect(hasHeadCommit(dir)).toBe(false);

    const result = ensureHeadCommit(dir);
    expect(result.ok).toBe(true);
    expect(result.createdInitialCommit).toBe(true);
    expect(hasHeadCommit(dir)).toBe(true);
  });
});
