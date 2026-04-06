import type { JobControlAction, TaskControlAction } from "../../shared/ipc";

declare global {
  interface Window {
    grist: {
      ping(): Promise<string>;
      dbPath(): Promise<string>;
      pickRepo(): Promise<string | null>;
      createJob(p: { repoPath: string; goal: string; operatorNotes?: string }): Promise<number>;
      getJob(id: number): Promise<unknown>;
      listJobs(): Promise<unknown[]>;
      updateJob(id: number, patch: { operator_notes?: string; user_goal?: string }): Promise<boolean>;
      runPlanner(jobId: number): Promise<boolean>;
      startScheduler(jobId: number): Promise<boolean>;
      stopScheduler(jobId: number): Promise<boolean>;
      snapshot(jobId: number): Promise<unknown>;
      getTasks(jobId: number): Promise<unknown[]>;
      getArtifacts(jobId: number): Promise<unknown[]>;
      getEvents(jobId: number): Promise<unknown[]>;
      getSettings(): Promise<Record<string, unknown>>;
      setSettings(p: Record<string, unknown>): Promise<boolean>;
      taskControl(a: TaskControlAction): Promise<boolean>;
      jobControl(a: JobControlAction): Promise<boolean>;
      runReducerNow(jobId: number): Promise<boolean>;
      spawnPatchTask(jobId: number, goal: string): Promise<number | null>;
      spawnVerifier(jobId: number, patchTaskId: number): Promise<number | null>;
      openPath(p: string): Promise<string>;
      onEvent(cb: (e: { kind: string; jobId?: number; taskId?: number; data?: unknown }) => void): () => void;
    };
  }
}

export {};
