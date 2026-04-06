import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc.js";
import type { TaskControlAction, JobControlAction, GristEvent } from "../shared/ipc.js";

const api = {
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
  dbPath: () => ipcRenderer.invoke(IPC.dbPath) as Promise<string>,
  pickRepo: () => ipcRenderer.invoke(IPC.pickRepo) as Promise<string | null>,
  recentRepos: () => ipcRenderer.invoke(IPC.recentRepos) as Promise<string[]>,
  isGitRepo: (p: string) => ipcRenderer.invoke(IPC.isGitRepo, p) as Promise<boolean>,
  initRepo: (dirPath?: string) => ipcRenderer.invoke(IPC.initRepo, dirPath) as Promise<string | null>,
  createJob: (payload: { repoPath: string; goal: string; operatorNotes?: string }) =>
    ipcRenderer.invoke(IPC.createJob, payload) as Promise<number>,
  getJob: (id: number) => ipcRenderer.invoke(IPC.getJob, id),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs),
  updateJob: (id: number, patch: { operator_notes?: string; user_goal?: string }) =>
    ipcRenderer.invoke(IPC.updateJob, id, patch),
  runPlanner: (jobId: number) => ipcRenderer.invoke(IPC.runPlanner, jobId),
  startScheduler: (jobId: number) => ipcRenderer.invoke(IPC.startScheduler, jobId),
  stopScheduler: (jobId: number) => ipcRenderer.invoke(IPC.stopScheduler, jobId),
  snapshot: (jobId: number) => ipcRenderer.invoke(IPC.snapshot, jobId),
  getTasks: (jobId: number) => ipcRenderer.invoke(IPC.getTasks, jobId),
  getArtifacts: (jobId: number) => ipcRenderer.invoke(IPC.getArtifacts, jobId),
  getEvents: (jobId: number) => ipcRenderer.invoke(IPC.getEvents, jobId),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (p: Record<string, unknown>) => ipcRenderer.invoke(IPC.setSettings, p),
  taskControl: (a: TaskControlAction) => ipcRenderer.invoke(IPC.taskControl, a),
  jobControl: (a: JobControlAction) => ipcRenderer.invoke(IPC.jobControl, a),
  runReducerNow: (jobId: number) => ipcRenderer.invoke(IPC.runReducerNow, jobId),
  spawnPatchTask: (jobId: number, goal: string) => ipcRenderer.invoke(IPC.spawnPatchTask, jobId, goal),
  spawnVerifier: (jobId: number, patchTaskId: number) =>
    ipcRenderer.invoke(IPC.spawnVerifier, jobId, patchTaskId),
  openPath: (p: string) => ipcRenderer.invoke(IPC.openPath, p) as Promise<string>,
  onEvent: (cb: (e: GristEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: GristEvent) => cb(payload);
    ipcRenderer.on(IPC.events, handler);
    return () => ipcRenderer.removeListener(IPC.events, handler);
  },
};

contextBridge.exposeInMainWorld("grist", api);

export type GristApi = typeof api;
