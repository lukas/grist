import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export type TaskRuntimeMode = "host" | "docker";
export type TaskRuntimeStatus = "unavailable" | "starting" | "running" | "failed" | "stopped";
export type TaskRuntimeStrategy = "none" | "compose" | "node_dev" | "dockerfile";

export interface TaskRuntimeState {
  mode: TaskRuntimeMode;
  status: TaskRuntimeStatus;
  strategy: TaskRuntimeStrategy;
  supportsExec: boolean;
  containerName?: string;
  imageTag?: string;
  composeFile?: string;
  composeProject?: string;
  hostPorts: Record<string, number>;
  serviceUrls: string[];
  workdir?: string;
  command?: string;
  lastError?: string;
  startedAt?: string;
}

interface RuntimeCandidate {
  strategy: Exclude<TaskRuntimeStrategy, "none">;
  containerPort?: number;
  command?: string;
  image?: string;
  composeFile?: string;
  supportsExec: boolean;
  workdir?: string;
}

const DEFAULT_RUNTIME: TaskRuntimeState = {
  mode: "host",
  status: "unavailable",
  strategy: "none",
  supportsExec: false,
  hostPorts: {},
  serviceUrls: [],
};

function runCommand(command: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: 300_000,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
  };
}

function detectPackageManager(worktreePath: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn";
  return "npm";
}

function nodeBootstrapCommands(worktreePath: string): { install: string; runPrefix: string } {
  const manager = detectPackageManager(worktreePath);
  switch (manager) {
    case "pnpm":
      return {
        install: "corepack enable && pnpm install --frozen-lockfile || corepack enable && pnpm install",
        runPrefix: "corepack enable && pnpm",
      };
    case "yarn":
      return {
        install: "corepack enable && yarn install --immutable || corepack enable && yarn install",
        runPrefix: "corepack enable && yarn",
      };
    case "npm":
    default:
      return {
        install: "npm install",
        runPrefix: "npm",
      };
  }
}

function isLikelyServerScript(script: string): boolean {
  const normalized = script.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\b(vite|next|nuxt|astro|remix|storybook|webpack-dev-server|react-scripts|nodemon|node-dev|http-server|live-server|serve)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(--host|--hostname|--port|HOST=|PORT=)\b/.test(normalized)) {
    return true;
  }
  if (/\b(node|tsx|ts-node)\b/.test(normalized) && /\b(server|api|web|www|listen)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function detectNodeRuntime(worktreePath: string): RuntimeCandidate | null {
  const packageJsonPath = join(worktreePath, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts || {};
    const { install, runPrefix } = nodeBootstrapCommands(worktreePath);
    if (scripts.dev) {
      const dev = scripts.dev;
      if (/\bvite\b/i.test(dev)) {
        return {
          strategy: "node_dev",
          containerPort: 5173,
          command: `${install} && ${runPrefix} run dev -- --host 0.0.0.0 --port 5173`,
          image: "node:20-bookworm",
          supportsExec: true,
          workdir: "/workspace",
        };
      }
      if (/\bnext\b.*\bdev\b/i.test(dev)) {
        return {
          strategy: "node_dev",
          containerPort: 3000,
          command: `${install} && ${runPrefix} run dev -- --hostname 0.0.0.0 --port 3000`,
          image: "node:20-bookworm",
          supportsExec: true,
          workdir: "/workspace",
        };
      }
      if (isLikelyServerScript(dev)) {
        return {
          strategy: "node_dev",
          containerPort: 3000,
          command: `${install} && HOST=0.0.0.0 PORT=3000 ${runPrefix} run dev`,
          image: "node:20-bookworm",
          supportsExec: true,
          workdir: "/workspace",
        };
      }
    }
    if (scripts.start && isLikelyServerScript(scripts.start)) {
      return {
        strategy: "node_dev",
        containerPort: 3000,
        command: `${install} && HOST=0.0.0.0 PORT=3000 ${runPrefix} start`,
        image: "node:20-bookworm",
        supportsExec: true,
        workdir: "/workspace",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export const __taskRuntimeInternals = {
  isLikelyServerScript,
};

function firstExposedPortFromDockerfile(worktreePath: string): number | undefined {
  const dockerfilePath = join(worktreePath, "Dockerfile");
  if (!existsSync(dockerfilePath)) return undefined;
  const content = readFileSync(dockerfilePath, "utf8");
  const match = content.match(/^\s*EXPOSE\s+(\d+)/m);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isFinite(port) ? port : undefined;
}

function detectDockerCandidate(worktreePath: string): RuntimeCandidate | null {
  for (const file of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (existsSync(join(worktreePath, file))) {
      return {
        strategy: "compose",
        composeFile: file,
        supportsExec: false,
      };
    }
  }

  const node = detectNodeRuntime(worktreePath);
  if (node) return node;

  if (existsSync(join(worktreePath, "Dockerfile"))) {
    return {
      strategy: "dockerfile",
      containerPort: firstExposedPortFromDockerfile(worktreePath),
      supportsExec: false,
    };
  }

  return null;
}

function dockerAvailable(worktreePath: string): boolean {
  return runCommand("docker version --format '{{.Server.Version}}'", worktreePath).ok;
}

function sanitizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function containerBaseName(jobId: number, taskId: number): string {
  return sanitizeName(`grist-${jobId}-${taskId}`);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function allocatePort(preferredBase: number): Promise<number> {
  for (let candidate = preferredBase; candidate < preferredBase + 2000; candidate += 1) {
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a free port near ${preferredBase}`);
}

function parseDockerPortLines(output: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/(\d+)\/tcp -> .*:(\d+)/);
    if (match) {
      result[`tcp_${match[1]}`] = Number(match[2]);
    }
  }
  return result;
}

function serviceUrlsFromPorts(ports: Record<string, number>): string[] {
  return Object.values(ports).map((port) => `http://127.0.0.1:${port}`);
}

function removeContainerByName(worktreePath: string, name: string): void {
  runCommand(`docker rm -f ${name}`, worktreePath);
}

function dockerExecCommand(containerName: string, workdir: string | undefined, command: string): string {
  const wd = workdir ? `-w ${JSON.stringify(workdir)} ` : "";
  return `docker exec ${wd}${containerName} sh -lc ${JSON.stringify(command)}`;
}

export function mapPathIntoRuntime(hostPath: string, worktreePath: string | null, runtime: TaskRuntimeState): string {
  if (!runtime.supportsExec || runtime.mode !== "docker") return hostPath;
  if (!worktreePath || !runtime.workdir) return hostPath;
  if (!hostPath.startsWith(worktreePath)) return hostPath;
  const suffix = hostPath.slice(worktreePath.length).replace(/^\/+/, "");
  return suffix ? `${runtime.workdir}/${suffix}` : runtime.workdir;
}

export function parseTaskRuntime(runtimeJson: string | null | undefined): TaskRuntimeState {
  try {
    const parsed = JSON.parse(runtimeJson || "{}") as Partial<TaskRuntimeState>;
    return {
      ...DEFAULT_RUNTIME,
      ...parsed,
      hostPorts: parsed.hostPorts || {},
      serviceUrls: parsed.serviceUrls || [],
      supportsExec: parsed.supportsExec ?? false,
    };
  } catch {
    return { ...DEFAULT_RUNTIME };
  }
}

export function stringifyTaskRuntime(runtime: TaskRuntimeState): string {
  return JSON.stringify(runtime);
}

export async function startBestEffortTaskRuntime(input: {
  jobId: number;
  taskId: number;
  repoPath: string;
  worktreePath: string;
}): Promise<TaskRuntimeState> {
  const { jobId, taskId, repoPath, worktreePath } = input;
  const candidate = detectDockerCandidate(worktreePath);
  if (!candidate) {
    return {
      ...DEFAULT_RUNTIME,
      lastError: "No Docker bootstrap strategy detected",
    };
  }
  if (!dockerAvailable(worktreePath)) {
    return {
      ...DEFAULT_RUNTIME,
      strategy: candidate.strategy,
      lastError: "Docker is not available on this machine",
    };
  }

  const name = containerBaseName(jobId, taskId);
  const preferredPort = 46000 + taskId * 10;
  const allocatedPort = candidate.containerPort ? await allocatePort(preferredPort) : undefined;

  if (candidate.strategy === "compose" && candidate.composeFile) {
    const project = `${name}-compose`;
    const up = runCommand(`docker compose -p ${project} -f ${candidate.composeFile} up -d --build`, worktreePath);
    if (!up.ok) {
      return {
        ...DEFAULT_RUNTIME,
        mode: "docker",
        strategy: "compose",
        status: "failed",
        lastError: up.stderr || up.stdout || "docker compose up failed",
      };
    }
    const names = runCommand(`docker ps --filter label=com.docker.compose.project=${project} --format '{{.Names}}'`, worktreePath);
    const containerName = names.stdout.split("\n").map((line) => line.trim()).find(Boolean);
    const ports = containerName
      ? parseDockerPortLines(runCommand(`docker port ${containerName}`, worktreePath).stdout)
      : {};
    return {
      mode: "docker",
      status: "running",
      strategy: "compose",
      supportsExec: false,
      composeFile: candidate.composeFile,
      composeProject: project,
      containerName,
      hostPorts: ports,
      serviceUrls: serviceUrlsFromPorts(ports),
      lastError: "",
      startedAt: new Date().toISOString(),
    };
  }

  if (candidate.strategy === "node_dev" && candidate.command && candidate.containerPort && candidate.image) {
    removeContainerByName(worktreePath, name);
    const command = [
      "docker run -d",
      `--name ${name}`,
      `-p ${allocatedPort}:${candidate.containerPort}`,
      `-v ${JSON.stringify(worktreePath)}:/workspace`,
      "-w /workspace",
      "-e HOST=0.0.0.0",
      `-e PORT=${candidate.containerPort}`,
      candidate.image,
      `sh -lc ${JSON.stringify(candidate.command)}`,
    ].join(" ");
    const run = runCommand(command, worktreePath);
    if (!run.ok) {
      return {
        ...DEFAULT_RUNTIME,
        mode: "docker",
        strategy: "node_dev",
        status: "failed",
        lastError: run.stderr || run.stdout || "docker run failed",
      };
    }
    const inspect = runCommand(`docker ps --filter name=${name} --format '{{.Names}}'`, worktreePath);
    if (!inspect.ok || !inspect.stdout.trim()) {
      const logs = runCommand(`docker logs ${name} --tail 80`, worktreePath);
      return {
        ...DEFAULT_RUNTIME,
        mode: "docker",
        strategy: "node_dev",
        status: "failed",
        lastError: logs.stderr || logs.stdout || "Container exited immediately",
      };
    }
    return {
      mode: "docker",
      status: "running",
      strategy: "node_dev",
      supportsExec: true,
      containerName: name,
      imageTag: candidate.image,
      hostPorts: allocatedPort ? { http: allocatedPort } : {},
      serviceUrls: allocatedPort ? [`http://127.0.0.1:${allocatedPort}`] : [],
      workdir: candidate.workdir,
      command: candidate.command,
      startedAt: new Date().toISOString(),
    };
  }

  if (candidate.strategy === "dockerfile") {
    const imageTag = `${name}:latest`;
    const build = runCommand(`docker build -t ${imageTag} .`, worktreePath);
    if (!build.ok) {
      return {
        ...DEFAULT_RUNTIME,
        mode: "docker",
        strategy: "dockerfile",
        status: "failed",
        lastError: build.stderr || build.stdout || "docker build failed",
      };
    }
    removeContainerByName(worktreePath, name);
    const portPart = candidate.containerPort && allocatedPort
      ? `-p ${allocatedPort}:${candidate.containerPort}`
      : "";
    const run = runCommand(`docker run -d --name ${name} ${portPart} ${imageTag}`, worktreePath);
    if (!run.ok) {
      return {
        ...DEFAULT_RUNTIME,
        mode: "docker",
        strategy: "dockerfile",
        status: "failed",
        imageTag,
        lastError: run.stderr || run.stdout || "docker run failed",
      };
    }
    return {
      mode: "docker",
      status: "running",
      strategy: "dockerfile",
      supportsExec: false,
      containerName: name,
      imageTag,
      hostPorts: allocatedPort ? { http: allocatedPort } : {},
      serviceUrls: allocatedPort ? [`http://127.0.0.1:${allocatedPort}`] : [],
      startedAt: new Date().toISOString(),
    };
  }

  return {
    ...DEFAULT_RUNTIME,
    lastError: "No Docker bootstrap strategy detected",
  };
}

export function stopTaskRuntime(runtime: TaskRuntimeState, worktreePath: string): void {
  if (runtime.mode !== "docker") return;
  if (runtime.strategy === "compose" && runtime.composeProject && runtime.composeFile) {
    runCommand(`docker compose -p ${runtime.composeProject} -f ${runtime.composeFile} down --remove-orphans`, worktreePath);
    return;
  }
  if (runtime.containerName) {
    removeContainerByName(worktreePath, runtime.containerName);
  }
}

export function buildRuntimeWrappedCommand(
  runtime: TaskRuntimeState | undefined,
  command: string,
  cwd: string,
  worktreePath: string | null,
): { command: string; cwd: string } {
  if (!runtime || runtime.mode !== "docker" || runtime.status !== "running" || !runtime.supportsExec || !runtime.containerName) {
    return { command, cwd };
  }
  const runtimeCwd = mapPathIntoRuntime(cwd, worktreePath, runtime);
  return {
    command: dockerExecCommand(runtime.containerName, runtimeCwd, command),
    cwd,
  };
}
