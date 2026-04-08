import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDatabase, closeDatabase, getDb } from "../backend/db/db.js";
import { repoLogsDir, ensureGristDir } from "../backend/logging/taskLogger.js";
import { loadDotenvFile } from "../backend/settings/loadDotenv.js";
import { GristOrchestrator } from "../backend/orchestrator/appOrchestrator.js";
import { IPC } from "../shared/ipc.js";
import { getSetting, setSetting, loadAppSettings, saveAppSettingsPatch } from "../backend/settings/appSettings.js";
import { createRootTask, listRootTasks, getRootTask, rootTaskToJobId, getChildTasks } from "../backend/db/rootTaskFacade.js";
import { listEventsByTaskId, listEvents } from "../backend/db/eventRepo.js";
import type { TaskControlAction, RootTaskControlAction } from "../shared/ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

app.name = "Grist";

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

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../dist-frontend/index.html"));
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

  ipcMain.handle(IPC.isGitRepo, (_, p: string) => {
    try {
      if (!existsSync(p)) return false;
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: p, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    closeDatabase();
    app.quit();
  }
});

app.on("before-quit", () => {
  closeDatabase();
});
