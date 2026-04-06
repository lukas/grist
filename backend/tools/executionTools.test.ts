import { describe, it, expect } from "vitest";
import { toolRunCommandSafe } from "./executionTools.js";
import type { ToolContext } from "./toolTypes.js";

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
});
