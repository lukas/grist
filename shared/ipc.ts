/** IPC contracts (preload <-> renderer <-> main). */

export const IPC = {
  ping: "grist:ping",
  dbPath: "grist:dbPath",
  pickRepo: "grist:pickRepo",
  recentRepos: "grist:recentRepos",
  repoDefaults: "grist:repoDefaults",
  createRepo: "grist:createRepo",
  initRepo: "grist:initRepo",
  isGitRepo: "grist:isGitRepo",

  // Unified task API
  createTask: "grist:createTask",
  startTask: "grist:startTask",
  listRootTasks: "grist:listRootTasks",
  getRootTask: "grist:getRootTask",
  getChildTasks: "grist:getChildTasks",
  getEventsForTask: "grist:getEventsForTask",
  getAllEvents: "grist:getAllEvents",
  stopTask: "grist:stopTask",
  rootTaskControl: "grist:rootTaskControl",
  taskControl: "grist:taskControl",
  sendTaskMessage: "grist:sendTaskMessage",

  // Settings
  getSettings: "grist:getSettings",
  setSettings: "grist:setSettings",

  // Memory
  getMemory: "grist:getMemory",
  getMemoryFile: "grist:getMemoryFile",
  updateMemorySummary: "grist:updateMemorySummary",
  getSkillsCatalog: "grist:getSkillsCatalog",
  installSkill: "grist:installSkill",
  removeSkill: "grist:removeSkill",
  readSkill: "grist:readSkill",

  // Utility
  openPath: "grist:openPath",
  logsDir: "grist:logsDir",

  /** Main -> renderer push (orchestrator updates). */
  events: "grist:events",
} as const;

export type TaskControlAction =
  | { type: "pause"; taskId: number }
  | { type: "stop"; taskId: number }
  | { type: "redirect"; taskId: number; newGoal: string; newScopeJson?: string }
  | { type: "fork"; taskId: number; newGoal: string; newScopeJson?: string; stopOriginal?: boolean }
  | { type: "reprioritize"; taskId: number; priority: number }
  | { type: "enqueue"; taskId: number };

/** @deprecated use RootTaskControlAction — kept for backend compat */
export type JobControlAction =
  | { type: "pause_all"; jobId: number }
  | { type: "resume_all"; jobId: number }
  | { type: "stop_run"; jobId: number }
  | { type: "summarize_now"; jobId: number };

export type RootTaskControlAction =
  | { type: "pause_all"; rootTaskId: number }
  | { type: "resume_all"; rootTaskId: number }
  | { type: "stop_run"; rootTaskId: number };

export type RepoDefaults = {
  defaultParent: string;
};

export type CreateRepoRequest = {
  name: string;
  parentDir?: string;
};

export type CreateRepoResult = {
  ok: boolean;
  path?: string;
  error?: string;
};

/** Main process `webContents.send(IPC.events, ...)` payload. */
export type GristEvent = { kind: string; jobId?: number; taskId?: number; data?: unknown };
