import { execSync, spawn, type ChildProcess } from "node:child_process";

export interface RemoteWorker {
  id: string;
  host: string;
  user: string;
  sshPort: number;
  workDir: string;
  maxSlots: number;
  activeSlots: number;
  status: "available" | "busy" | "offline" | "draining";
  lastHealthCheck: number;
  capabilities: string[];
}

const workers = new Map<string, RemoteWorker>();

export function registerRemoteWorker(config: {
  host: string;
  user?: string;
  sshPort?: number;
  workDir?: string;
  maxSlots?: number;
  capabilities?: string[];
}): RemoteWorker {
  const id = `${config.user || "grist"}@${config.host}:${config.sshPort || 22}`;
  const worker: RemoteWorker = {
    id,
    host: config.host,
    user: config.user || "grist",
    sshPort: config.sshPort || 22,
    workDir: config.workDir || "/tmp/grist-work",
    maxSlots: config.maxSlots || 2,
    activeSlots: 0,
    status: "available",
    lastHealthCheck: 0,
    capabilities: config.capabilities || ["docker", "node", "python"],
  };
  workers.set(id, worker);
  return worker;
}

export function removeRemoteWorker(id: string): boolean {
  return workers.delete(id);
}

export function listRemoteWorkers(): RemoteWorker[] {
  return [...workers.values()];
}

export function getAvailableRemoteWorker(): RemoteWorker | null {
  for (const worker of workers.values()) {
    if (worker.status === "available" && worker.activeSlots < worker.maxSlots) {
      return worker;
    }
  }
  return null;
}

export function acquireRemoteSlot(workerId: string): boolean {
  const worker = workers.get(workerId);
  if (!worker || worker.status !== "available" || worker.activeSlots >= worker.maxSlots) return false;
  worker.activeSlots += 1;
  if (worker.activeSlots >= worker.maxSlots) worker.status = "busy";
  return true;
}

export function releaseRemoteSlot(workerId: string): void {
  const worker = workers.get(workerId);
  if (!worker) return;
  worker.activeSlots = Math.max(0, worker.activeSlots - 1);
  if (worker.status === "busy" && worker.activeSlots < worker.maxSlots) {
    worker.status = "available";
  }
}

function sshCommand(worker: RemoteWorker, cmd: string): string {
  const portFlag = worker.sshPort !== 22 ? `-p ${worker.sshPort}` : "";
  return `ssh ${portFlag} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${worker.user}@${worker.host} ${JSON.stringify(cmd)}`;
}

export function healthCheck(workerId: string): { ok: boolean; latencyMs: number; error?: string } {
  const worker = workers.get(workerId);
  if (!worker) return { ok: false, latencyMs: 0, error: "Worker not found" };
  const start = Date.now();
  try {
    execSync(sshCommand(worker, "echo ok"), { timeout: 15_000 });
    worker.lastHealthCheck = Date.now();
    if (worker.status === "offline") worker.status = "available";
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    worker.status = "offline";
    return { ok: false, latencyMs: Date.now() - start, error: String(e) };
  }
}

export function runRemoteCommand(
  workerId: string,
  command: string,
  cwd?: string,
  timeoutMs: number = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const worker = workers.get(workerId);
  if (!worker) return Promise.resolve({ code: 1, stdout: "", stderr: "Worker not found" });

  const remoteCwd = cwd || worker.workDir;
  const remoteCmd = `cd ${JSON.stringify(remoteCwd)} && ${command}`;

  return new Promise((resolve) => {
    const portArgs = worker.sshPort !== 22 ? ["-p", String(worker.sshPort)] : [];
    const child = spawn("ssh", [
      ...portArgs,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `${worker.user}@${worker.host}`,
      remoteCmd,
    ]);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

export function syncRepoToRemote(
  workerId: string,
  localRepoPath: string,
  remoteDir?: string,
): { ok: boolean; error?: string } {
  const worker = workers.get(workerId);
  if (!worker) return { ok: false, error: "Worker not found" };
  const target = remoteDir || `${worker.workDir}/repo`;
  try {
    const portFlag = worker.sshPort !== 22 ? `-e "ssh -p ${worker.sshPort}"` : "";
    execSync(
      `rsync -az --delete --exclude=node_modules --exclude=.git/objects ${portFlag} ${JSON.stringify(localRepoPath + "/")} ${worker.user}@${worker.host}:${JSON.stringify(target + "/")}`,
      { timeout: 60_000 },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function syncResultsFromRemote(
  workerId: string,
  remoteDir: string,
  localDir: string,
): { ok: boolean; error?: string } {
  const worker = workers.get(workerId);
  if (!worker) return { ok: false, error: "Worker not found" };
  try {
    const portFlag = worker.sshPort !== 22 ? `-e "ssh -p ${worker.sshPort}"` : "";
    execSync(
      `rsync -az --exclude=node_modules --exclude=.git/objects ${portFlag} ${worker.user}@${worker.host}:${JSON.stringify(remoteDir + "/")} ${JSON.stringify(localDir + "/")}`,
      { timeout: 60_000 },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function totalRemoteSlots(): number {
  let total = 0;
  for (const w of workers.values()) {
    if (w.status !== "offline") total += w.maxSlots;
  }
  return total;
}

export function availableRemoteSlots(): number {
  let total = 0;
  for (const w of workers.values()) {
    if (w.status === "available") total += (w.maxSlots - w.activeSlots);
  }
  return total;
}
