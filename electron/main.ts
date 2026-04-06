import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { openDatabase, closeDatabase } from "../backend/db/db.js";
import { SwarmOrchestrator } from "../backend/orchestrator/appOrchestrator.js";
import { IPC } from "../shared/ipc.js";
import { getSetting, setSetting, loadAppSettings, saveAppSettingsPatch } from "../backend/settings/appSettings.js";
import { updateJob } from "../backend/db/jobRepo.js";
import type { TaskControlAction, JobControlAction } from "../shared/ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let orchestrator: SwarmOrchestrator;

function broadcast(payload: { kind: string; jobId?: number; taskId?: number; data?: unknown }): void {
  mainWindow?.webContents.send(IPC.events, payload);
}

function createWindow(): void {
  const preloadPath = join(__dirname, "preload.cjs");
  if (!existsSync(preloadPath)) {
    console.error("Preload missing at", preloadPath);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Swarm Operator",
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
  ipcMain.handle(IPC.dbPath, () => join(app.getPath("userData"), "swarm.sqlite"));

  ipcMain.handle(IPC.pickRepo, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle(IPC.createJob, (_, payload: { repoPath: string; goal: string; operatorNotes?: string }) => {
    const s = loadAppSettings();
    return orchestrator.createJob({
      repoPath: payload.repoPath,
      goal: payload.goal,
      operatorNotes: payload.operatorNotes,
      defaultProvider: s.defaultProvider,
      plannerProvider: s.plannerProvider,
      reducerProvider: s.reducerProvider,
      verifierProvider: s.verifierProvider,
    });
  });

  ipcMain.handle(IPC.getJob, (_, id: number) => orchestrator.listAllJobs().find((j) => j.id === id) ?? null);

  ipcMain.handle(IPC.listJobs, () => orchestrator.listAllJobs());

  ipcMain.handle(IPC.updateJob, (_, id: number, patch: { operator_notes?: string; user_goal?: string }) => {
    updateJob(id, patch);
    return true;
  });

  ipcMain.handle(IPC.runPlanner, (_, jobId: number) => {
    orchestrator.planJob(jobId);
    return true;
  });

  ipcMain.handle(IPC.startScheduler, (_, jobId: number) => {
    orchestrator.startScheduler(jobId);
    return true;
  });

  ipcMain.handle(IPC.stopScheduler, (_, jobId: number) => {
    orchestrator.stopScheduler(jobId);
    return true;
  });

  ipcMain.handle(IPC.getTasks, (_, jobId: number) => orchestrator.snapshot(jobId).tasks);
  ipcMain.handle(IPC.getArtifacts, (_, jobId: number) => orchestrator.snapshot(jobId).artifacts);
  ipcMain.handle(IPC.getEvents, (_, jobId: number) => orchestrator.snapshot(jobId).events);

  ipcMain.handle(IPC.getSettings, () => loadAppSettings());
  ipcMain.handle(IPC.setSettings, (_, p: Record<string, unknown>) => {
    saveAppSettingsPatch(p as never);
    return true;
  });

  ipcMain.handle(IPC.taskControl, (_, a: TaskControlAction) => {
    orchestrator.taskControl(a);
    return true;
  });

  ipcMain.handle(IPC.jobControl, (_, a: JobControlAction) => {
    orchestrator.jobControl(a);
    return true;
  });

  ipcMain.handle(IPC.runReducerNow, async (_, jobId: number) => {
    await orchestrator.runReducerNow(jobId);
    return true;
  });

  ipcMain.handle(IPC.spawnPatchTask, (_, jobId: number, goal: string) => orchestrator.spawnPatchTask(jobId, goal));

  ipcMain.handle(IPC.spawnVerifier, (_, jobId: number, patchTaskId: number) =>
    orchestrator.spawnVerifierTask(jobId, patchTaskId)
  );

  ipcMain.handle(IPC.snapshot, (_, jobId: number) => orchestrator.snapshot(jobId));

  ipcMain.handle(IPC.openPath, (_, p: string) => shell.openPath(p));
}

app.whenReady().then(() => {
  const dbPath = join(app.getPath("userData"), "swarm.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  openDatabase(dbPath);

  const ws = ensureWorkspaceRoot();
  orchestrator = new SwarmOrchestrator(ws);
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
