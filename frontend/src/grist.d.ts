import type { TaskControlAction, RootTaskControlAction } from "../../shared/ipc";

declare global {
  interface RootTaskSummary {
    id: number;
    user_goal: string;
    status: string;
    repo_path: string;
    created_at: string;
    updated_at: string;
  }

  interface RootTaskRow extends RootTaskSummary {
    operator_notes: string;
    total_tokens_used: number;
    total_estimated_cost: number;
  }

  interface ChildTask {
    id: number;
    role: string;
    kind: string;
    status: string;
    goal: string;
    assigned_model_provider: string;
    confidence: number;
    tokens_used: number;
    steps_used: number;
    max_steps: number;
    workspace_repo_mode: string;
    findings_json: string;
    dependencies_json: string;
    parent_task_id: number | null;
    blocker: string;
    current_action: string;
  }

  interface TaskEvent {
    id: number;
    level: string;
    type: string;
    message: string;
    data_json: string | null;
    created_at: string;
    task_id: number | null;
  }

  interface MemoryFileInfo {
    name: string;
    content: string;
    mtime: number;
  }

  interface MemoryData {
    repoSummary: string;
    homeSummary: string;
    repoFiles: MemoryFileInfo[];
    homeFiles: MemoryFileInfo[];
  }

  interface MemorySelection {
    scope: "project" | "global";
    type: "summary" | "file";
    name: string;
  }

  interface Window {
    grist: {
      ping(): Promise<string>;
      dbPath(): Promise<string>;
      pickRepo(): Promise<string | null>;
      recentRepos(): Promise<string[]>;
      isGitRepo(p: string): Promise<boolean>;
      initRepo(dirPath?: string): Promise<string | null>;

      createTask(p: { repoPath: string; goal: string; notes?: string }): Promise<number>;
      startTask(rootTaskId: number): Promise<boolean>;
      listRootTasks(repo?: string): Promise<RootTaskSummary[]>;
      getRootTask(rootTaskId: number): Promise<RootTaskRow | null>;
      getChildTasks(rootTaskId: number): Promise<ChildTask[]>;
      getEventsForTask(taskId: number): Promise<TaskEvent[]>;
      getAllEvents(rootTaskId: number): Promise<TaskEvent[]>;
      stopTask(rootTaskId: number): Promise<boolean>;
      rootTaskControl(a: RootTaskControlAction): Promise<boolean>;
      taskControl(a: TaskControlAction): Promise<boolean>;
      sendTaskMessage(taskId: number, message: string): Promise<boolean>;

      getSettings(): Promise<Record<string, unknown>>;
      setSettings(p: Record<string, unknown>): Promise<boolean>;

      getMemory(repoPath: string): Promise<MemoryData>;
      getMemoryFile(p: { scope: string; name: string; repoPath?: string }): Promise<string>;
      updateMemorySummary(p: { scope: string; content: string; repoPath?: string }): Promise<boolean>;

      openPath(p: string): Promise<string>;
      logsDir(rootTaskId: number): Promise<string>;

      onEvent(cb: (e: { kind: string; jobId?: number; taskId?: number; data?: unknown }) => void): () => void;
    };
  }
}

export {};
