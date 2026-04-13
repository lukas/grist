import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } from "electron";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDatabase, closeDatabase, getDb } from "../backend/db/db.js";
import { repoLogsDir, ensureGristDir } from "../backend/logging/taskLogger.js";
import { loadDotenvFile } from "../backend/settings/loadDotenv.js";
import { GristOrchestrator } from "../backend/orchestrator/appOrchestrator.js";
import { IPC } from "../shared/ipc.js";
import { getSetting, setSetting, loadAppSettings, saveAppSettingsPatch } from "../backend/settings/appSettings.js";
import { getFullMemoryData, readHomeMemoryFile, readRepoMemoryFile, writeHomeSummary, writeRepoSummary } from "../backend/memory/memoryManager.js";
import { getSkillCatalog, installSkill, readInstalledSkill, removeSkill } from "../backend/skills/skillManager.js";
import { createRootTask, listRootTasks, getRootTask, rootTaskToJobId, getChildTasks } from "../backend/db/rootTaskFacade.js";
import { insertEvent, listEventsByTaskId, listEvents } from "../backend/db/eventRepo.js";
import { getTask, updateTask, listTasksForJob } from "../backend/db/taskRepo.js";
import { getJob, updateJob, listJobs } from "../backend/db/jobRepo.js";
import type { TaskControlAction, RootTaskControlAction } from "../shared/ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

app.name = "Grist";

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let orchestrator: GristOrchestrator;

function broadcast(payload: { kind: string; jobId?: number; taskId?: number; data?: unknown }): void {
  mainWindow?.webContents.send(IPC.events, payload);
}

function createWindow(): void {
  const preloadPath = join(__dirname, "preload.cjs");
  if (!existsSync(preloadPath)) {
    console.error("Preload missing at", preloadPath);
  }

  const iconPath = join(__dirname, "..", "assets", "icon.png");
  const appIcon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  if (appIcon && process.platform === "darwin") {
    app.dock?.setIcon(appIcon);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Grist",
    icon: appIcon,
  });

  mainWindow.webContents.on("preload-error", (_event, path, err) => {
    console.error("preload-error", path, err);
  });

  if (isDev && process.env.GRIST_DEV_SERVER === "1") {
    mainWindow.loadURL("http://localhost:5173");
  }  else {
    mainWindow.loadFile(join(__dirname, "../dist-frontend/index.html"));
  }
  if (process.env.GRIST_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function ensureWorkspaceRoot(): string {
  const existing = getSetting("appWorkspaceRoot") as string | undefined;
  if (existing && existsSync(existing)) return existing;
  const root = join(app.getPath("userData"), "workspace");
  mkdirSync(root, { recursive: true });
  setSetting("appWorkspaceRoot", root);
  return root;
}

function expandUserPath(p: string): string {
  return p.startsWith("~/") ? join(app.getPath("home"), p.slice(2)) : p;
}

function defaultRepoParent(): string {
  return join(app.getPath("home"), "grist-repos");
}

function isGitRepoPath(dirPath: string): boolean {
  try {
    if (!existsSync(dirPath)) return false;
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dirPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.ping, () => "pong");
  ipcMain.handle(IPC.dbPath, () => join(app.getPath("userData"), "grist.sqlite"));

  ipcMain.handle(IPC.pickRepo, async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle(IPC.recentRepos, () => {
    const rows = getDb()
      .prepare("SELECT DISTINCT repo_path FROM jobs ORDER BY created_at DESC LIMIT 20")
      .all() as { repo_path: string }[];
    return rows.map((r) => r.repo_path).filter((p) => existsSync(p));
  });

  ipcMain.handle(IPC.repoDefaults, () => ({
    defaultParent: defaultRepoParent(),
  }));

  ipcMain.handle(IPC.createRepo, (_, payload: { name: string; parentDir?: string }) => {
    const name = payload.name.trim();
    if (!name) {
      return { ok: false, error: "Repo name is required." };
    }
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      return { ok: false, error: "Repo name cannot contain path separators." };
    }

    const parentDir = expandUserPath((payload.parentDir || "").trim() || defaultRepoParent());
    const target = join(parentDir, name);

    try {
      mkdirSync(parentDir, { recursive: true });

      if (existsSync(target)) {
        if (isGitRepoPath(target)) {
          return { ok: true, path: target };
        }
        if (readdirSync(target).length > 0) {
          return { ok: false, error: `Folder already exists and is not empty: ${target}` };
        }
      } else {
        mkdirSync(target, { recursive: true });
      }

      execFileSync("git", ["init"], { cwd: target, stdio: "pipe" });
      return { ok: true, path: target };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create repo.",
      };
    }
  });

  ipcMain.handle(IPC.isGitRepo, (_, p: string) => {
    return isGitRepoPath(expandUserPath(p));
  });

  ipcMain.handle(IPC.initRepo, async (_, dirPath?: string) => {
    let target = dirPath;
    if (!target) {
      const r = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Choose folder for new git repo",
      });
      if (r.canceled || !r.filePaths[0]) return null;
      target = r.filePaths[0];
    }
    target = expandUserPath(target);
    try {
      mkdirSync(target, { recursive: true });
      execFileSync("git", ["init"], { cwd: target, stdio: "pipe" });
      return target;
    } catch {
      return null;
    }
  });

  // --- Unified task API ---

  ipcMain.handle(IPC.createTask, (_, payload: { repoPath: string; goal: string; notes?: string }) => {
    const s = loadAppSettings();
    ensureGristDir(payload.repoPath);
    return createRootTask({
      repoPath: payload.repoPath,
      goal: payload.goal,
      notes: payload.notes,
      defaultProvider: s.defaultProvider,
      plannerProvider: s.plannerProvider,
      reducerProvider: s.reducerProvider,
      verifierProvider: s.verifierProvider,
    });
  });

  ipcMain.handle(IPC.startTask, async (_, rootTaskId: number) => {
    const jobId = rootTaskToJobId(rootTaskId);
    if (!jobId) return false;
    await orchestrator.planJob(jobId);
    orchestrator.startScheduler(jobId);
    return true;
  });

  ipcMain.handle(IPC.listRootTasks, (_, repo?: string) => listRootTasks(repo));

  ipcMain.handle(IPC.getRootTask, (_, rootTaskId: number) => getRootTask(rootTaskId));

  ipcMain.handle(IPC.getChildTasks, (_, rootTaskId: number) => getChildTasks(rootTaskId));

  ipcMain.handle(IPC.getEventsForTask, (_, taskId: number) => listEventsByTaskId(taskId));

  ipcMain.handle(IPC.getAllEvents, (_, rootTaskId: number) => {
    const jobId = rootTaskToJobId(rootTaskId);
    if (!jobId) return [];
    return listEvents(jobId);
  });

  ipcMain.handle(IPC.rootTaskControl, (_, a: RootTaskControlAction) => {
    const jobId = rootTaskToJobId(a.rootTaskId);
    if (!jobId) return false;
    if (a.type === "pause_all") {
      orchestrator.jobControl({ type: "pause_all", jobId });
    } else if (a.type === "resume_all") {
      orchestrator.jobControl({ type: "resume_all", jobId });
      orchestrator.startScheduler(jobId);
    } else if (a.type === "stop_run") {
      orchestrator.jobControl({ type: "stop_run", jobId });
    }
    return true;
  });

  ipcMain.handle(IPC.taskControl, (_, a: TaskControlAction) => {
    orchestrator.taskControl(a);
    return true;
  });

  ipcMain.handle(IPC.sendTaskMessage, (_, payload: { taskId: number; message: string }) => {
    const task = getTask(payload.taskId);
    if (!task) return false;
    insertEvent({
      job_id: task.job_id,
      task_id: payload.taskId,
      level: "info",
      type: "user_message",
      message: payload.message,
    });
    const terminal = ["done", "failed", "stopped", "paused"];
    if (terminal.includes(task.status)) {
      updateTask(payload.taskId, { status: "queued", blocker: "" });
      const job = getJob(task.job_id);
      console.log(`[sendTaskMessage] task ${payload.taskId} was ${task.status}, job ${task.job_id} is ${job?.status}`);
      if (job && !["running", "paused"].includes(job.status)) {
        updateJob(task.job_id, { status: "running" });
        console.log(`[sendTaskMessage] set job ${task.job_id} to running`);
      }
      orchestrator.stopScheduler(task.job_id);
      orchestrator.startScheduler(task.job_id);
      console.log(`[sendTaskMessage] scheduler restarted for job ${task.job_id}`);
    }
    return true;
  });

  ipcMain.handle(IPC.stopTask, (_, rootTaskId: number) => {
    const jobId = rootTaskToJobId(rootTaskId);
    if (!jobId) return false;
    orchestrator.jobControl({ type: "stop_run", jobId });
    return true;
  });

  // --- Settings ---

  ipcMain.handle(IPC.getSettings, () => loadAppSettings());
  ipcMain.handle(IPC.setSettings, (_, p: Record<string, unknown>) => {
    saveAppSettingsPatch(p as never);
    return true;
  });

  // --- Memory ---

  ipcMain.handle(IPC.getMemory, (_, repoPath: string) => {
    try {
      return getFullMemoryData(repoPath);
    } catch (e) {
      console.error("[getMemory] error:", e);
      return { repoSummary: "", homeSummary: "", repoFiles: [], homeFiles: [] };
    }
  });

  ipcMain.handle(IPC.getMemoryFile, (_, payload: { scope: string; name: string; repoPath?: string }) => {
    if (payload.scope === "global") return readHomeMemoryFile(payload.name);
    if (payload.repoPath) return readRepoMemoryFile(payload.repoPath, payload.name);
    return "";
  });

  ipcMain.handle(IPC.updateMemorySummary, (_, payload: { scope: string; content: string; repoPath?: string }) => {
    if (payload.scope === "global") { writeHomeSummary(payload.content); return true; }
    if (payload.repoPath) { writeRepoSummary(payload.repoPath, payload.content); return true; }
    return false;
  });

  ipcMain.handle(IPC.getSkillsCatalog, (_, repoPath?: string) => {
    try { return getSkillCatalog(repoPath); }
    catch (e) { console.error("[getSkillsCatalog]", e); return { available: [], installedGlobal: [], installedProject: [] }; }
  });
  ipcMain.handle(IPC.installSkill, (_, payload: { skillOrUrl: string; scope?: "global" | "project"; repoPath?: string }) =>
    installSkill(payload)
  );
  ipcMain.handle(IPC.removeSkill, (_, payload: { skillId: string; scope: "global" | "project"; repoPath?: string }) =>
    removeSkill(payload.skillId, payload.scope, payload.repoPath)
  );
  ipcMain.handle(IPC.readSkill, (_, payload: { skillId: string; scope?: "global" | "project"; repoPath?: string; file?: string }) =>
    readInstalledSkill(payload.skillId, payload)
  );

  // --- Utility ---

  ipcMain.handle(IPC.openPath, (_, p: string) => shell.openPath(p));

  ipcMain.handle(IPC.logsDir, (_, rootTaskId: number) => {
    const root = getRootTask(rootTaskId);
    return root ? repoLogsDir(root.repo_path) : "";
  });
}

app.whenReady().then(() => {
  const envPath = loadDotenvFile([join(__dirname, "..", ".env")]);
  if (envPath) {
    console.log("[grist] loaded env file:", envPath);
  }

  const dbPath = join(app.getPath("userData"), "grist.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  openDatabase(dbPath);

  const ws = ensureWorkspaceRoot();
  orchestrator = new GristOrchestrator(ws);
  orchestrator.setBroadcast(broadcast);

  registerIpc();
  createWindow();

  // Auto-plan and start any draft jobs that were created but not yet started
  for (const job of listJobs()) {
    if (job.status === "draft") {
      const tasks = listTasksForJob(job.id);
      const rootTask = tasks.find((t) => t.kind === "root" && t.status === "queued");
      if (rootTask) {
        console.log(`[startup] auto-planning draft job ${job.id}`);
        orchestrator.planJob(job.id).then(() => {
          orchestrator.startScheduler(job.id);
          console.log(`[startup] scheduler started for job ${job.id}`);
        }).catch((e) => {
          console.error(`[startup] failed to plan job ${job.id}:`, e);
        });
      }
    }
  }

  // Resume schedulers for any jobs with active tasks
  const activeStatuses = new Set(["queued", "ready", "running", "blocked"]);
  for (const job of listJobs()) {
    if (["running", "paused"].includes(job.status)) {
      const tasks = listTasksForJob(job.id);
      if (tasks.some((t) => activeStatuses.has(t.status))) {
        console.log(`[startup] resuming scheduler for job ${job.id} (${job.status})`);
        orchestrator.startScheduler(job.id);
      }
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (!mainWindow) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  orchestrator?.cleanupAllRuntimes();
  for (const job of listJobs()) {
    orchestrator?.stopScheduler(job.id);
  }
});

app.on("quit", () => {
  closeDatabase();
});
