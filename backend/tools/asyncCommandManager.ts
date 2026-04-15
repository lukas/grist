import { spawn, type ChildProcess } from "node:child_process";

interface BgCommand {
  id: string;
  taskId: number;
  command: string;
  cwd: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

const commands = new Map<string, BgCommand>();
let nextId = 1;

export function startBackgroundCommand(
  taskId: number,
  command: string,
  cwd: string,
  timeoutMs: number = 600_000,
  extraEnv?: Record<string, string>,
): { id: string } {
  const id = `bg-${taskId}-${nextId++}`;
  const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv } });
  const entry: BgCommand = {
    id,
    taskId,
    command,
    cwd,
    child,
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  child.stdout?.on("data", (d) => {
    entry.stdout += d.toString();
    if (entry.stdout.length > 500_000) entry.stdout = entry.stdout.slice(-400_000);
  });
  child.stderr?.on("data", (d) => {
    entry.stderr += d.toString();
    if (entry.stderr.length > 200_000) entry.stderr = entry.stderr.slice(-150_000);
  });
  child.on("close", (code) => {
    entry.exitCode = code ?? 1;
    entry.finishedAt = Date.now();
  });
  const timer = setTimeout(() => {
    if (entry.exitCode === null) {
      child.kill("SIGKILL");
      entry.exitCode = 124;
      entry.stderr += "\n[timeout]";
      entry.finishedAt = Date.now();
    }
  }, timeoutMs);
  child.on("close", () => clearTimeout(timer));
  commands.set(id, entry);
  return { id };
}

export function pollBackgroundCommand(id: string): {
  id: string;
  done: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
} | null {
  const entry = commands.get(id);
  if (!entry) return null;
  const done = entry.exitCode !== null;
  return {
    id: entry.id,
    done,
    exitCode: entry.exitCode,
    stdout: entry.stdout.slice(-50_000),
    stderr: entry.stderr.slice(-20_000),
    elapsedMs: (entry.finishedAt || Date.now()) - entry.startedAt,
  };
}

export function cleanupTaskCommands(taskId: number): void {
  for (const [id, entry] of commands) {
    if (entry.taskId === taskId) {
      if (entry.exitCode === null) entry.child.kill("SIGKILL");
      commands.delete(id);
    }
  }
}
