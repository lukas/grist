import { spawn } from "node:child_process";
import type { ToolContext, ToolResult } from "./toolTypes.js";
import { buildRuntimeWrappedCommand } from "../runtime/taskRuntime.js";

function isAllowed(command: string, allowlist: string[]): boolean {
  const c = command.trim();
  for (const entry of allowlist) {
    if (c === entry || c.startsWith(entry + " ")) return true;
  }
  // Allow wrapper commands (timeout, env, nice) if the inner command is allowed
  const wrapperMatch = c.match(/^(?:timeout|env|nice|nohup)\s+(?:\S+\s+)*?(\S+.*)/);
  if (wrapperMatch) {
    const inner = wrapperMatch[1];
    for (const entry of allowlist) {
      if (inner === entry || inner.startsWith(entry + " ")) return true;
    }
  }
  // Allow piped/redirected commands if the base command is allowed
  const pipeMatch = c.match(/^([^|<>&;]+)/);
  if (pipeMatch && pipeMatch[1].trim() !== c) {
    const base = pipeMatch[1].trim();
    for (const entry of allowlist) {
      if (base === entry || base.startsWith(entry + " ")) return true;
    }
  }
  return false;
}

function runWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", onAbort);
    child.on("error", (err) => {
      clearTimeout(t);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function toolRunCommandSafe(
  ctx: ToolContext,
  args: { command: string; cwd?: string; timeoutMs?: number },
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const cwd = args.cwd ? args.cwd : (ctx.worktreePath || ctx.repoPath);
  if (!isAllowed(args.command, ctx.commandAllowlist)) {
    return { ok: false, error: `Command not in allowlist: ${args.command}` };
  }
  try {
    const wrapped = buildRuntimeWrappedCommand(ctx.runtime, args.command, cwd, ctx.worktreePath);
    const r = await runWithTimeout(wrapped.command, wrapped.cwd, timeoutMs, abortSignal, ctx.commandEnv);
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function toolRunTests(
  ctx: ToolContext,
  args: { command?: string; target?: string; cwd?: string },
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  const cmd = args.command || "npm test";
  const cwd = args.cwd ?? (ctx.worktreePath || ctx.repoPath);
  return toolRunCommandSafe(ctx, { command: cmd, cwd, timeoutMs: 120_000 }, abortSignal);
}

export async function toolRunLint(
  ctx: ToolContext,
  args: { command?: string },
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  const cmd = args.command || "npm run lint";
  return toolRunCommandSafe(ctx, { command: cmd, timeoutMs: 120_000 }, abortSignal);
}
