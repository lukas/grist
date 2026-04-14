import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolApplyPatch } from "./patchTools.js";
import type { ToolContext } from "./toolTypes.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(worktreePath: string): ToolContext {
  return {
    jobId: 1,
    taskId: 1,
    repoPath: worktreePath,
    worktreePath,
    scopeFiles: [],
    scratchpadPath: join(worktreePath, ".grist/scratch.md"),
    appWorkspaceRoot: worktreePath,
    allowedToolNames: ["apply_patch"],
    commandAllowlist: [],
    emit: () => {},
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("toolApplyPatch", () => {
  it("returns a clear error when diff content is missing", () => {
    const dir = makeTempDir("grist-patch-");
    const result = toolApplyPatch(makeCtx(dir), {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("non-empty diff or patch");
  });

  it("accepts patch as an alias for diff", () => {
    const dir = makeTempDir("grist-patch-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/file.ts"), "export const value = 1;\n");
    const patch = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

    const result = toolApplyPatch(makeCtx(dir), { patch });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src/file.ts"), "utf8")).toContain("value = 2");
  });
});
