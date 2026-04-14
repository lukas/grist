import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolListFiles, toolReadFile } from "./repoTools.js";
import type { ToolContext } from "./toolTypes.js";

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

function baseCtx(repoPath: string, worktreePath: string | null): ToolContext {
  return {
    jobId: 1,
    taskId: 1,
    repoPath,
    worktreePath,
    scopeFiles: [],
    scratchpadPath: join(repoPath, ".grist/scratch.md"),
    appWorkspaceRoot: repoPath,
    allowedToolNames: [],
    commandAllowlist: [],
    emit: () => {},
  };
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("repo tools use worktree when present", () => {
  it("lists files from the worktree root", () => {
    const repoPath = makeTempDir("grist-repo-");
    const worktreePath = makeTempDir("grist-worktree-");
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src/index.ts"), "console.log('hi');\n");

    const result = toolListFiles(baseCtx(repoPath, worktreePath), { path: ".", recursive: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((result.data as { files: string[] }).files).toContain("src/index.ts");
  });

  it("reads files from the worktree root", () => {
    const repoPath = makeTempDir("grist-repo-");
    const worktreePath = makeTempDir("grist-worktree-");
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src/index.ts"), "export const value = 42;\n");

    const result = toolReadFile(baseCtx(repoPath, worktreePath), { path: "src/index.ts" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((result.data as { lines: string }).lines).toContain("value = 42");
  });
});
