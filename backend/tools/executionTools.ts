import { spawn } from "node:child_process";
import { join, isAbsolute, normalize } from "node:path";
import type { ToolContext, ToolResult } from "./toolTypes.js";
import { buildRuntimeWrappedCommand } from "../runtime/taskRuntime.js";

function isDirectlyAllowed(command: string, allowlist: string[]): boolean {
  const c = command.trim();
  for (const entry of allowlist) {
    if (c === entry || c.startsWith(entry + " ")) return true;
  }
  return false;
}

function unwrapCommand(command: string): string | null {
  const c = command.trim();
  const envMatch = c.match(/^env\s+(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*(.*)$/);
  if (envMatch && envMatch[1]) return envMatch[1].trim();
  const timeoutMatch = c.match(/^timeout\s+(?:-[^\s]+\s+)*(?:\d+[smhd]?\s+)?(.*)$/);
  if (timeoutMatch && timeoutMatch[1]) return timeoutMatch[1].trim();
  const niceMatch = c.match(/^nice\s+(?:-n\s+-?\d+\s+)?(.*)$/);
  if (niceMatch && niceMatch[1]) return niceMatch[1].trim();
  const nohupMatch = c.match(/^nohup\s+(.*)$/);
  if (nohupMatch && nohupMatch[1]) return nohupMatch[1].trim();
  return null;
}

function splitTopLevelCommands(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "&") {
      if (ch === "&" && next === "&") {
        if (!current.trim()) return null;
        segments.push(current.trim());
        current = "";
        i += 1;
        continue;
      }
      return null;
    }
    if (ch === ";") {
      if (!current.trim()) return null;
      segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        if (!current.trim()) return null;
        segments.push(current.trim());
        current = "";
        i += 1;
        continue;
      }
      if (!current.trim()) return null;
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || escaped) return null;
  if (current.trim()) segments.push(current.trim());
  return segments.length > 1 ? segments : null;
}

function hasTopLevelShellSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === ">" || ch === "<") return true;
    if (ch === "&" || ch === "|") {
      if (next === ch) return true;
      if (ch === "|") return true;
      return true;
    }
  }
  return false;
}

function isAllowed(command: string, allowlist: string[]): boolean {
  const c = command.trim();
  if (!c) return false;
  const unwrapped = unwrapCommand(c);
  if (unwrapped) {
    return isAllowed(unwrapped, allowlist);
  }
  const segments = splitTopLevelCommands(c);
  if (segments) {
    return segments.every((segment) => isAllowed(segment, allowlist));
  }
  if (hasTopLevelShellSyntax(c)) return false;
  if (isDirectlyAllowed(c, allowlist)) return true;
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCommandForRuntime(command: string, ctx: ToolContext): string {
  const runtime = ctx.runtime;
  if (!runtime || runtime.mode !== "docker" || !runtime.workdir) return command.trim();
  const workdir = escapeRegExp(runtime.workdir);
  return command
    .trim()
    .replace(new RegExp(`^cd\\s+(?:"${workdir}"|'${workdir}'|${workdir})\\s*(?:&&|;)\\s*`), "");
}

function resolveCommandCwd(ctx: ToolContext, cwd?: string): string {
  const base = ctx.worktreePath || ctx.repoPath;
  if (!cwd || cwd.trim() === "") return base;
  const trimmed = cwd.trim();
  if (trimmed === ".") return base;
  return isAbsolute(trimmed) ? trimmed : normalize(join(base, trimmed));
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
  const cwd = resolveCommandCwd(ctx, args.cwd);
  const normalizedCommand = normalizeCommandForRuntime(args.command, ctx);
  if (!isAllowed(normalizedCommand, ctx.commandAllowlist)) {
    return { ok: false, error: `Command not in allowlist: ${args.command}` };
  }
  try {
    const wrapped = buildRuntimeWrappedCommand(ctx.runtime, normalizedCommand, cwd, ctx.worktreePath);
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

export const __executionToolInternals = {
  hasTopLevelShellSyntax,
  isAllowed,
  normalizeCommandForRuntime,
  resolveCommandCwd,
  splitTopLevelCommands,
};
