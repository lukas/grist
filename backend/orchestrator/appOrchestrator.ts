import { copyFileSync, existsSync } from "node:fs";
import { insertJob, getJob, updateJob, listJobs } from "../db/jobRepo.js";
import { insertTask, updateTask, getTask, listTasksForJob } from "../db/taskRepo.js";
import { listArtifactsForJob } from "../db/artifactRepo.js";
import { listEvents } from "../db/eventRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { runPlanner } from "./planner.js";
import { runSchedulerTick } from "./scheduler.js";
import { runTaskWorker } from "./workerRunner.js";
import { runReducerPass } from "./reducer.js";
import { createWorktree } from "../workspace/worktreeManager.js";
import { defaultWorktreePath, scratchpadPath } from "../workspace/pathUtils.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";
import type { TaskControlAction, JobControlAction } from "../../shared/ipc.js";
import type { ModelProviderName } from "../types/models.js";

const PATCH_TOOLS = ALL_TOOL_NAMES.filter((n) => n !== "remove_worktree");

export type BroadcastFn = (payload: { kind: string; jobId?: number; taskId?: number; data?: unknown }) => void;

export class GristOrchestrator {
  private timers = new Map<number, ReturnType<typeof setInterval>>();
  private inflight = new Map<number, Promise<void>>();
  private aborts = new Map<number, AbortController>();
  private broadcast: BroadcastFn = () => {};

  constructor(private appWorkspaceRoot: string) {}

  setWorkspaceRoot(p: string): void {
    this.appWorkspaceRoot = p;
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  private emit(kind: string, jobId?: number, taskId?: number, data?: unknown): void {
    this.broadcast({ kind, jobId, taskId, data });
  }

  createJob(input: {
    repoPath: string;
    goal: string;
    operatorNotes?: string;
    defaultProvider?: ModelProviderName;
    plannerProvider?: ModelProviderName;
    reducerProvider?: ModelProviderName;
    verifierProvider?: ModelProviderName;
  }): number {
    const d = input.defaultProvider || "mock";
    return insertJob({
      repo_path: input.repoPath,
      user_goal: input.goal,
      operator_notes: input.operatorNotes || "",
      status: "draft",
      selected_execution_mode: "local",
      default_model_provider: d,
      planner_model_provider: input.plannerProvider || d,
      reducer_model_provider: input.reducerProvider || d,
      verifier_model_provider: input.verifierProvider || d,
    });
  }

  planJob(jobId: number): void {
    const job = getJob(jobId);
    if (!job) return;
    runPlanner(job, this.appWorkspaceRoot);
    this.emit("planner_done", jobId);
  }

  startScheduler(jobId: number): void {
    if (this.timers.has(jobId)) return;
    const timer = setInterval(() => {
      runSchedulerTick(jobId, {
        onStartWorker: (taskId) => {
          if (this.inflight.has(taskId)) return;
          const ac = new AbortController();
          this.aborts.set(taskId, ac);
          const p = runTaskWorker(taskId, ac.signal, this.appWorkspaceRoot, (msg) => {
            this.emit("duplicate_hint", jobId, taskId, { msg });
          })
            .catch((e) => {
              insertEvent({
                job_id: jobId,
                task_id: taskId,
                level: "error",
                type: "worker_crash",
                message: String(e),
              });
              updateTask(taskId, { status: "failed", blocker: String(e) });
            })
            .finally(() => {
              this.aborts.delete(taskId);
              this.inflight.delete(taskId);
              this.emit("worker_done", jobId, taskId);
            });
          this.inflight.set(taskId, p);
        },
      });
    }, 500);
    this.timers.set(jobId, timer);
    this.emit("scheduler_started", jobId);
  }

  stopScheduler(jobId: number): void {
    const t = this.timers.get(jobId);
    if (t) clearInterval(t);
    this.timers.delete(jobId);
    this.emit("scheduler_stopped", jobId);
  }

  async runReducerNow(jobId: number): Promise<void> {
    const tasks = listTasksForJob(jobId).filter((t) => t.kind === "reducer");
    const r = tasks[0];
    if (!r) return;
    updateJob(jobId, { status: "reducing" });
    await runReducerPass(r);
    updateJob(jobId, { status: "running" });
    this.emit("reducer_manual", jobId);
  }

  spawnPatchTask(jobId: number, goal: string): number | null {
    const job = getJob(jobId);
    if (!job) return null;
    const branch = `grist-patch-${Date.now()}`;
    const id = insertTask({
      job_id: jobId,
      parent_task_id: null,
      kind: "patch_writer",
      role: "patch_writer",
      goal,
      scope_json: JSON.stringify({}),
      status: "queued",
      priority: 50,
      assigned_model_provider: job.default_model_provider as ModelProviderName,
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "",
      worktree_path: null,
      max_steps: 32,
      max_tokens: 48000,
      current_action: "init",
      next_action: "create_worktree",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(PATCH_TOOLS),
      artifact_type: "candidate_patch",
    });
    const wt = defaultWorktreePath(this.appWorkspaceRoot, jobId, id);
    const res = createWorktree(job.repo_path, wt, "HEAD", branch);
    if (!res.ok) {
      insertEvent({
        job_id: jobId,
        task_id: id,
        level: "error",
        type: "worktree_failed",
        message: res.stderr,
      });
      updateTask(id, { status: "failed", blocker: res.stderr });
      return id;
    }
    const sp = scratchpadPath(this.appWorkspaceRoot, jobId, id);
    updateTask(id, { worktree_path: wt, scratchpad_path: sp });
    ensureScratchpad(sp);
    insertEvent({
      job_id: jobId,
      task_id: id,
      level: "info",
      type: "patch_task_spawned",
      message: `Worktree ${wt}`,
    });
    this.emit("patch_spawned", jobId, id);
    return id;
  }

  spawnVerifierTask(jobId: number, patchTaskId: number): number | null {
    const patch = getTask(patchTaskId);
    const job = getJob(jobId);
    if (!patch || !job || !patch.worktree_path) return null;
    const id = insertTask({
      job_id: jobId,
      parent_task_id: patchTaskId,
      kind: "verifier",
      role: "verifier",
      goal: `Verify patch from task ${patchTaskId}`,
      scope_json: JSON.stringify({ patchTaskId }),
      status: "queued",
      priority: 200,
      assigned_model_provider: job.verifier_model_provider as ModelProviderName,
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "",
      worktree_path: patch.worktree_path,
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verify",
      next_action: "tests",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([patchTaskId]),
      allowed_tools_json: JSON.stringify(["run_tests", "run_command_safe", "read_scratchpad", "emit_progress_event"]),
      artifact_type: "verification_result",
    });
    const sp = scratchpadPath(this.appWorkspaceRoot, jobId, id);
    updateTask(id, { scratchpad_path: sp, status: "blocked", blocker: "waiting for patch task" });
    ensureScratchpad(sp);
    insertEvent({
      job_id: jobId,
      task_id: id,
      level: "info",
      type: "verifier_spawned",
      message: `Verifier for patch ${patchTaskId}`,
    });
    return id;
  }

  taskControl(a: TaskControlAction): void {
    if (a.type === "pause") {
      updateTask(a.taskId, { status: "paused" });
      this.emit("task_paused", undefined, a.taskId);
      return;
    }
    if (a.type === "stop") {
      this.aborts.get(a.taskId)?.abort();
      updateTask(a.taskId, { status: "stopped" });
      this.emit("task_stopped", undefined, a.taskId);
      return;
    }
    if (a.type === "redirect") {
      const t0 = getTask(a.taskId);
      if (!t0) return;
      updateTask(a.taskId, {
        goal: a.newGoal,
        ...(a.newScopeJson != null ? { scope_json: a.newScopeJson } : {}),
        next_action: "redirected",
      });
      insertEvent({
        job_id: t0.job_id,
        task_id: a.taskId,
        level: "info",
        type: "task_redirected",
        message: a.newGoal.slice(0, 200),
      });
      this.emit("task_redirected", t0.job_id, a.taskId);
      return;
    }
    if (a.type === "reprioritize") {
      updateTask(a.taskId, { priority: a.priority });
      return;
    }
    if (a.type === "enqueue") {
      const t = getTask(a.taskId);
      if (t && (t.status === "paused" || t.status === "stopped")) {
        updateTask(a.taskId, { status: "queued", blocker: "" });
      }
      return;
    }
    if (a.type === "fork") {
      const t = getTask(a.taskId);
      const job = t ? getJob(t.job_id) : undefined;
      if (!t || !job) return;
      const nid = insertTask({
        job_id: t.job_id,
        parent_task_id: a.stopOriginal ? null : t.id,
        kind: t.kind,
        role: `${t.role}_fork`,
        goal: a.newGoal,
        scope_json: a.newScopeJson ?? t.scope_json,
        status: "queued",
        priority: t.priority - 1,
        assigned_model_provider: t.assigned_model_provider,
        write_mode: t.write_mode,
        workspace_repo_mode: t.workspace_repo_mode,
        scratchpad_path: "",
        worktree_path: t.worktree_path,
        max_steps: t.max_steps,
        max_tokens: t.max_tokens,
        current_action: "forked",
        next_action: "start",
        blocker: "",
        confidence: t.confidence,
        files_examined_json: t.files_examined_json,
        findings_json: t.findings_json,
        open_questions_json: t.open_questions_json,
        dependencies_json: t.dependencies_json,
        allowed_tools_json: t.allowed_tools_json,
        artifact_type: t.artifact_type,
      });
      const sp = scratchpadPath(this.appWorkspaceRoot, t.job_id, nid);
      updateTask(nid, { scratchpad_path: sp });
      ensureScratchpad(sp);
      if (existsSync(t.scratchpad_path)) {
        try {
          copyFileSync(t.scratchpad_path, sp);
        } catch {
          /* ignore */
        }
      }
      if (a.stopOriginal) {
        this.aborts.get(t.id)?.abort();
        updateTask(t.id, { status: "stopped" });
      }
      insertEvent({
        job_id: t.job_id,
        task_id: nid,
        level: "info",
        type: "task_forked",
        message: `Forked from ${t.id}`,
      });
      this.emit("task_forked", t.job_id, nid);
    }
  }

  jobControl(a: JobControlAction): void {
    if (a.type === "pause_all") {
      updateJob(a.jobId, { status: "paused" });
      for (const t of listTasksForJob(a.jobId)) {
        if (t.status === "running" || t.status === "ready") {
          updateTask(t.id, { status: "paused" });
        }
      }
      return;
    }
    if (a.type === "resume_all") {
      updateJob(a.jobId, { status: "running" });
      for (const t of listTasksForJob(a.jobId)) {
        if (t.status === "paused") updateTask(t.id, { status: "queued" });
      }
      return;
    }
    if (a.type === "stop_run") {
      this.stopScheduler(a.jobId);
      updateJob(a.jobId, { status: "stopped" });
      for (const t of listTasksForJob(a.jobId)) {
        if (["running", "ready", "queued"].includes(t.status)) {
          this.aborts.get(t.id)?.abort();
          updateTask(t.id, { status: "stopped" });
        }
      }
      return;
    }
    if (a.type === "summarize_now") {
      void this.runReducerNow(a.jobId);
    }
  }

  snapshot(jobId: number) {
    return {
      job: getJob(jobId),
      tasks: listTasksForJob(jobId),
      artifacts: listArtifactsForJob(jobId),
      events: listEvents(jobId, 400),
    };
  }

  listAllJobs() {
    return listJobs();
  }
}
