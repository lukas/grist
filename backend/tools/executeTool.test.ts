import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool } from "./executeTool.js";
import type { ToolContext } from "./toolTypes.js";

function ctx(repo: string, allowed: string[]): ToolContext {
  const scratch = join(repo, "scratch.md");
  writeFileSync(scratch, "# s\n", "utf8");
  return {
    jobId: 1,
    taskId: 1,
    repoPath: repo,
    worktreePath: null,
    scopeFiles: undefined,
    scratchpadPath: scratch,
    appWorkspaceRoot: join(repo, ".swarm"),
    allowedToolNames: allowed,
    commandAllowlist: ["echo ok"],
    emit: () => {},
  };
}

describe("executeTool", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "grist-ex-"));
    writeFileSync(join(repo, "README.md"), "hello\nworld\n", "utf8");
    mkdirSync(join(repo, "pkg"), { recursive: true });
    writeFileSync(join(repo, "pkg", "util.ts"), "import x from 'y'\n", "utf8");
  });

  it("list_files lists top-level entries", async () => {
    const c = ctx(repo, ["list_files"]);
    const r = await executeTool("list_files", { path: ".", recursive: false }, c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const files = (r.data as { files: string[] }).files;
      expect(files.some((f) => f.includes("README.md") || f === "README.md")).toBe(true);
    }
  });

  it("read_file returns line slice", async () => {
    const c = ctx(repo, ["read_file"]);
    const r = await executeTool("read_file", { path: "README.md", startLine: 1, endLine: 1 }, c);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { lines: string }).lines.trim()).toBe("hello");
  });

  it("grep_code finds pattern", async () => {
    const c = ctx(repo, ["grep_code"]);
    const r = await executeTool("grep_code", { pattern: "import", scopePaths: ["."] }, c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hits = (r.data as { hits: { file: string }[] }).hits;
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it("rejects disallowed tool", async () => {
    const c = ctx(repo, ["read_file"]);
    const r = await executeTool("list_files", {}, c);
    expect(r.ok).toBe(false);
  });

  it("write_file fails without worktree", async () => {
    const c = ctx(repo, ["write_file"]);
    const r = await executeTool("write_file", { path: "x.txt", content: "z" }, c);
    expect(r.ok).toBe(false);
  });

  it("write_file rejects paths outside task scope", async () => {
    const c = { ...ctx(repo, ["write_file"]), worktreePath: repo, scopeFiles: ["owned.js"] };
    const r = await executeTool("write_file", { path: "other.js", content: "z" }, c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Write outside task scope");
  });

  it("write_file allows paths inside task scope", async () => {
    const c = { ...ctx(repo, ["write_file"]), worktreePath: repo, scopeFiles: ["owned.js"] };
    const r = await executeTool("write_file", { path: "owned.js", content: "z" }, c);
    expect(r.ok).toBe(true);
  });
});
