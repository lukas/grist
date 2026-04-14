import { describe, expect, it } from "vitest";
import { __executionToolInternals, toolRunCommandSafe } from "./executionTools.js";
import type { ToolContext } from "./toolTypes.js";

function makeCtx(runtime?: ToolContext["runtime"]): ToolContext {
  return {
    jobId: 1,
    taskId: 1,
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/repo",
    scratchpadPath: "/tmp/repo/.grist/scratch.md",
    appWorkspaceRoot: "/tmp/repo",
    allowedToolNames: [],
    commandAllowlist: [],
    runtime,
    emit: () => {},
  };
}

describe("executionTools runtime normalization", () => {
  it("strips redundant runtime workdir prefixes", () => {
    const normalized = __executionToolInternals.normalizeCommandForRuntime(
      "cd /workspace && npm test",
      makeCtx({
        mode: "docker",
        status: "running",
        strategy: "node_dev",
        supportsExec: true,
        containerName: "grist-1-1",
        workdir: "/workspace",
        hostPorts: {},
        serviceUrls: [],
      }),
    );

    expect(normalized).toBe("npm test");
  });

  it("leaves host commands unchanged", () => {
    const normalized = __executionToolInternals.normalizeCommandForRuntime(
      "cd /workspace && npm test",
      makeCtx({
        mode: "host",
        status: "unavailable",
        strategy: "none",
        supportsExec: false,
        hostPorts: {},
        serviceUrls: [],
      }),
    );

    expect(normalized).toBe("cd /workspace && npm test");
  });

  it("splits simple chained commands at top level", () => {
    expect(__executionToolInternals.splitTopLevelCommands("pwd && ls -la")).toEqual(["pwd", "ls -la"]);
    expect(__executionToolInternals.splitTopLevelCommands("git diff | head")).toEqual(["git diff", "head"]);
  });

  it("resolves relative cwd against the worktree", () => {
    const resolved = __executionToolInternals.resolveCommandCwd(
      makeCtx({
        mode: "host",
        status: "unavailable",
        strategy: "none",
        supportsExec: false,
        hostPorts: {},
        serviceUrls: [],
      }),
      ".",
    );

    expect(resolved).toBe("/tmp/repo");
  });
});

const ctxBase: Omit<ToolContext, "emit"> = {
  jobId: 1,
  taskId: 1,
  repoPath: "/tmp",
  worktreePath: null,
  scratchpadPath: "/tmp/s",
  appWorkspaceRoot: "/w",
  allowedToolNames: ["run_command_safe"],
  commandAllowlist: ["echo ok"],
};

describe("toolRunCommandSafe", () => {
  it("rejects commands not in allowlist", async () => {
    const emit = () => {};
    const ctx = { ...ctxBase, emit } as ToolContext;
    const r = await toolRunCommandSafe(ctx, { command: "rm -rf /" });
    expect(r.ok).toBe(false);
  });

  it("allows listed commands", async () => {
    const ctx = {
      ...ctxBase,
      emit: () => {},
    } as ToolContext;
    const r = await toolRunCommandSafe(ctx, { command: "echo ok", timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { code: number }).code).toBe(0);
  });

  it("allows benign chained commands only when every segment is allowlisted", () => {
    expect(__executionToolInternals.isAllowed("pwd && ls -la", ["pwd", "ls"])).toBe(true);
    expect(__executionToolInternals.isAllowed("gh --version", ["gh --version"])).toBe(true);
  });

  it("rejects dangerous or redirecting chained commands", () => {
    expect(__executionToolInternals.isAllowed("ls && rm -rf /", ["ls"])).toBe(false);
    expect(__executionToolInternals.isAllowed("echo ok > out.txt", ["echo"])).toBe(false);
  });
});
