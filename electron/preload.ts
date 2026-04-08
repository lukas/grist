import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc.js";
import type { TaskControlAction, RootTaskControlAction, GristEvent } from "../shared/ipc.js";

const api = {
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
  dbPath: () => ipcRenderer.invoke(IPC.dbPath) as Promise<string>,
  pickRepo: () => ipcRenderer.invoke(IPC.pickRepo) as Promise<string | null>,
  recentRepos: () => ipcRenderer.invoke(IPC.recentRepos) as Promise<string[]>,
  isGitRepo: (p: string) => ipcRenderer.invoke(IPC.isGitRepo, p) as Promise<boolean>,
  initRepo: (dirPath?: string) => ipcRenderer.invoke(IPC.initRepo, dirPath) as Promise<string | null>,

  createTask: (payload: { repoPath: string; goal: string; notes?: string }) =>
    ipcRenderer.invoke(IPC.createTask, payload) as Promise<number>,
  startTask: (rootTaskId: number) =>
    ipcRenderer.invoke(IPC.startTask, rootTaskId) as Promise<boolean>,
  listRootTasks: (repo?: string) =>
    ipcRenderer.invoke(IPC.listRootTasks, repo) as Promise<unknown[]>,
  getRootTask: (rootTaskId: number) =>
    ipcRenderer.invoke(IPC.getRootTask, rootTaskId) as Promise<unknown>,
  getChildTasks: (rootTaskId: number) =>
    ipcRenderer.invoke(IPC.getChildTasks, rootTaskId) as Promise<unknown[]>,
  getEventsForTask: (taskId: number) =>
    ipcRenderer.invoke(IPC.getEventsForTask, taskId) as Promise<unknown[]>,
  getAllEvents: (rootTaskId: number) =>
    ipcRenderer.invoke(IPC.getAllEvents, rootTaskId) as Promise<unknown[]>,
  stopTask: (rootTaskId: number) =>
    ipcRenderer.invoke(IPC.stopTask, rootTaskId) as Promise<boolean>,
  rootTaskControl: (a: RootTaskControlAction) =>
    ipcRenderer.invoke(IPC.rootTaskControl, a) as Promise<boolean>,
  taskControl: (a: TaskControlAction) =>
    ipcRenderer.invoke(IPC.taskControl, a) as Promise<boolean>,
  sendTaskMessage: (taskId: number, message: string) =>
    ipcRenderer.invoke(IPC.sendTaskMessage, { taskId, message }) as Promise<boolean>,

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (p: Record<string, unknown>) => ipcRenderer.invoke(IPC.setSettings, p),

  getMemory: (repoPath: string) => ipcRenderer.invoke(IPC.getMemory, repoPath),
  getMemoryFile: (payload: { scope: string; name: string; repoPath?: string }) =>
    ipcRenderer.invoke(IPC.getMemoryFile, payload) as Promise<string>,
  updateMemorySummary: (payload: { scope: string; content: string; repoPath?: string }) =>
    ipcRenderer.invoke(IPC.updateMemorySummary, payload) as Promise<boolean>,

  openPath: (p: string) => ipcRenderer.invoke(IPC.openPath, p) as Promise<string>,
  logsDir: (rootTaskId: number) => ipcRenderer.invoke(IPC.logsDir, rootTaskId) as Promise<string>,

  onEvent: (cb: (e: GristEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: GristEvent) => cb(payload);
    ipcRenderer.on(IPC.events, handler);
    return () => ipcRenderer.removeListener(IPC.events, handler);
  },
};

contextBridge.exposeInMainWorld("grist", api);

export type GristApi = typeof api;
