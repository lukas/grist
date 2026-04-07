/** IPC contracts (preload ↔ renderer ↔ main). */

export const IPC = {
  ping: "grist:ping",
  dbPath: "grist:dbPath",
  pickRepo: "grist:pickRepo",
  recentRepos: "grist:recentRepos",
  initRepo: "grist:initRepo",
  isGitRepo: "grist:isGitRepo",
  createJob: "grist:createJob",
  getJob: "grist:getJob",
  listJobs: "grist:listJobs",
  updateJob: "grist:updateJob",
  runPlanner: "grist:runPlanner",
  startScheduler: "grist:startScheduler",
  stopScheduler: "grist:stopScheduler",
  getTasks: "grist:getTasks",
  getArtifacts: "grist:getArtifacts",
  getEvents: "grist:getEvents",
  getTaskEvents: "grist:getTaskEvents",
  getJobLevelEvents: "grist:getJobLevelEvents",
  getSettings: "grist:getSettings",
  setSettings: "grist:setSettings",
  taskControl: "grist:taskControl",
  jobControl: "grist:jobControl",
  runReducerNow: "grist:runReducerNow",
  spawnPatchTask: "grist:spawnPatchTask",
  spawnVerifier: "grist:spawnVerifier",
  snapshot: "grist:snapshot",
  openPath: "grist:openPath",
  logsDir: "grist:logsDir",
  taskLog: "grist:taskLog",
  subscribe: "grist:subscribe",
  /** Main → renderer push (orchestrator updates). */
  events: "grist:events",
} as const;

export type TaskControlAction =
  | { type: "pause"; taskId: number }
  | { type: "stop"; taskId: number }
  | { type: "redirect"; taskId: number; newGoal: string; newScopeJson?: string }
  | { type: "fork"; taskId: number; newGoal: string; newScopeJson?: string; stopOriginal?: boolean }
  | { type: "reprioritize"; taskId: number; priority: number }
  | { type: "enqueue"; taskId: number };

export type JobControlAction =
  | { type: "pause_all"; jobId: number }
  | { type: "resume_all"; jobId: number }
  | { type: "stop_run"; jobId: number }
  | { type: "summarize_now"; jobId: number };

/** Main process `webContents.send(IPC.events, …)` payload. */
export type GristEvent = { kind: string; jobId?: number; taskId?: number; data?: unknown };
