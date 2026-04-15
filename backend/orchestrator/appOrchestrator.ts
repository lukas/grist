import { copyFileSync, existsSync } from "node:fs";
import { ensureGristDir } from "../logging/taskLogger.js";
import { insertJob, getJob, updateJob, listJobs } from "../db/jobRepo.js";
import { insertTask, updateTask, getTask, listTasksForJob } from "../db/taskRepo.js";
import { getLatestArtifactForTask, insertArtifact, listArtifactsForJob } from "../db/artifactRepo.js";
import { listEvents, listEventsForTask, listJobLevelEvents } from "../db/eventRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { runPlanner } from "./planner.js";
import { runSchedulerTick } from "./scheduler.js";
import { runTaskWorker } from "./workerRunner.js";
import { runReducerPass } from "./reducer.js";
import { createWorktree, listWorktreeSyncableChanges, syncWorktreeToRepo } from "../workspace/worktreeManager.js";
import { defaultWorktreePath, scratchpadPath } from "../workspace/pathUtils.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import {
  parseTaskRuntime,
  startBestEffortTaskRuntime,
  stopTaskRuntime,
  stringifyTaskRuntime,
} from "../runtime/taskRuntime.js";
import { ensureGitRepo, ensureHeadCommit, defaultBranchName } from "../workspace/gitRepoManager.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";
import type { TaskControlAction, JobControlAction } from "../../shared/ipc.js";
import type { ModelProviderName } from "../types/models.js";
import { VerifierOutputSchema, WorkerPacketSchema } from "../types/taskState.js";
import { canSafelyForkTask, classifyContractViolation, parseWorkerPacket, taskContract } from "../services/contractService.js";
import { maybePersistReflection } from "../services/reflectionService.js";
import { MAX_REPAIR_ATTEMPTS, shouldReplan } from "./replanPolicy.js";

const PATCH_TOOLS = ALL_TOOL_NAMES.filter((n) => !["remove_worktree", "create_worktree"].includes(n));

const MIN_RESUME_STEP_BUMP = 5;
const MIN_RESUME_TOKEN_BUMP = 50_000;

export function explicitResumeBudgetPatch(task: { max_steps: number; max_tokens: number }): {
  max_steps: number;
  max_tokens: number;
  stepBump: number;
  tokenBump: number;
} {
  const stepBump = Math.max(MIN_RESUME_STEP_BUMP, Math.ceil(task.max_steps * 0.25));
  const tokenBump = Math.max(MIN_RESUME_TOKEN_BUMP, Math.ceil(task.max_tokens * 0.25));
  return {
    max_steps: task.max_steps + stepBump,
    max_tokens: task.max_tokens + tokenBump,
    stepBump,
    tokenBump,
  };
}

export type BroadcastFn = (payload: { kind: string; jobId?: number; taskId?: number; data?: unknown }) => void;

function countImplementerDepth(taskId: number, tasksById: Map<number, ReturnType<typeof getTask>>): number {
  let depth = 0;
  let cursor = tasksById.get(taskId);
  while (cursor) {
    if (cursor.role === "implementer") depth += 1;
    cursor = cursor.parent_task_id ? tasksById.get(cursor.parent_task_id) : undefined;
  }
  return depth;
}

function buildVerifierRepairGoal(originalGoal: string, summary: string, failures: string[], nextAction: string): string {
  const parts = [
    `Repair the issues found by verification for: ${originalGoal}`,
    summary ? `Verifier summary: ${summary}` : "",
    failures.length > 0 ? `Failures to address: ${failures.join("; ")}` : "",
    nextAction ? `Recommended next action: ${nextAction}` : "",
    "Fix the issue in the existing implementation branch, rerun the relevant validation, and leave a coherent runnable result.",
  ].filter(Boolean);
  return parts.join("\n");
}

function isWrapupTask(scopeJson: string): boolean {
  return parseWorkerPacket(scopeJson).workflow_phase === "wrapup";
}

function buildWrapupGoal(originalGoal: string): string {
  return [
    `Wrap up the completed work for: ${originalGoal}`,
    "Clean up obvious rough edges, update relevant documentation, prepare git/PR handoff, and write durable memory notes.",
  ].join("\n");
}

function readVerifierArtifact(taskId: number) {
  const latestArtifact = getLatestArtifactForTask(taskId, "verification_result") as
    | { content_json: string }
    | undefined;
  if (!latestArtifact) return null;
  try {
    return VerifierOutputSchema.parse(JSON.parse(latestArtifact.content_json));
  } catch {
    return null;
  }
}

function countRequestedReplans(jobId: number): number {
  return (listEvents(jobId, 1000) as Array<{ type: string }>).filter((event) => event.type === "replan_requested").length;
}

export function spawnAutoRepairTaskForVerifier(
  verifierTaskId: number,
  appWorkspaceRoot: string
): number | null {
  const verifier = getTask(verifierTaskId);
  if (!verifier || verifier.role !== "verifier") return null;
  const parent = verifier.parent_task_id ? getTask(verifier.parent_task_id) : undefined;
  if (!parent || parent.role !== "implementer") return null;
  const job = getJob(verifier.job_id);
  if (!job) return null;

  const existingRepair = listTasksForJob(verifier.job_id).find(
    (candidate) => candidate.parent_task_id === verifier.id && candidate.role === "implementer"
  );
  if (existingRepair) return existingRepair.id;

  const parsed = readVerifierArtifact(verifier.id);
  if (!parsed) return null;
  if (parsed.passed) return null;

  const tasks = listTasksForJob(verifier.job_id);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const depth = countImplementerDepth(parent.id, tasksById);
  if (depth >= MAX_REPAIR_ATTEMPTS) {
    insertEvent({
      job_id: verifier.job_id,
      task_id: verifier.id,
      level: "warn",
      type: "repair_skipped",
      message: `Skipping automatic repair after verifier failure because repair depth ${depth} reached the cap`,
      data_json: JSON.stringify({ depth, cap: MAX_REPAIR_ATTEMPTS }),
    });
    return null;
  }

  const repairTaskId = insertTask({
    job_id: verifier.job_id,
    parent_task_id: verifier.id,
    kind: "patch_writer",
    role: "implementer",
    goal: buildVerifierRepairGoal(
      parent.goal,
      parsed.summary,
      parsed.failures || [],
      parsed.recommended_next_action || ""
    ),
    scope_json: parent.scope_json,
    status: "queued",
    priority: Math.max(parent.priority + 1, 220),
    assigned_model_provider: parent.assigned_model_provider,
    write_mode: "worktree",
    workspace_repo_mode: "isolated_worktree",
    scratchpad_path: "",
    worktree_path: parent.worktree_path,
    git_branch: parent.git_branch,
    base_ref: parent.git_branch || parent.base_ref,
    runtime_json: "{}",
    max_steps: Math.max(16, Math.min(parent.max_steps, 32)),
    max_tokens: Math.max(48_000, Math.min(parent.max_tokens, 200_000)),
    current_action: "repair_requested",
    next_action: "start",
    blocker: "",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: JSON.stringify(parsed.failures || []),
    open_questions_json: "[]",
    dependencies_json: JSON.stringify([verifier.id]),
    allowed_tools_json: parent.allowed_tools_json || JSON.stringify(PATCH_TOOLS),
    artifact_type: "candidate_patch",
  });
  const sp = scratchpadPath(appWorkspaceRoot, verifier.job_id, repairTaskId);
  updateTask(repairTaskId, { scratchpad_path: sp });
  ensureScratchpad(sp);
  insertEvent({
    job_id: verifier.job_id,
    task_id: repairTaskId,
    level: "info",
    type: "repair_task_spawned",
    message: `Spawned repair implementer from verifier ${verifier.id}`,
    data_json: JSON.stringify({
      verifierTaskId: verifier.id,
      worktreePath: parent.worktree_path,
      baseRef: parent.git_branch || parent.base_ref,
      failures: parsed.failures || [],
    }),
  });
  return repairTaskId;
}

export function applyVerifiedWorktreeToRepo(verifierTaskId: number): boolean {
  const verifier = getTask(verifierTaskId);
  if (!verifier || verifier.role !== "verifier") return false;
  const parent = verifier.parent_task_id ? getTask(verifier.parent_task_id) : undefined;
  const job = getJob(verifier.job_id);
  const parsed = readVerifierArtifact(verifier.id);
  if (!job || !parent || parent.role !== "implementer" || !parent.worktree_path || !parsed?.passed) return false;

  const syncResult = syncWorktreeToRepo(job.repo_path, parent.worktree_path);
  insertEvent({
    job_id: verifier.job_id,
    task_id: verifier.id,
    level: syncResult.ok ? "info" : "warn",
    type: syncResult.ok ? "verified_patch_applied" : "verified_patch_apply_failed",
    message: syncResult.ok
      ? `Applied ${syncResult.copied.length} file(s) from verified worktree to repo`
      : `Failed to apply verified worktree to repo: ${syncResult.stderr}`,
    data_json: JSON.stringify(syncResult),
  });
  return syncResult.ok;
}

export function spawnWrapupTaskForVerifier(
  verifierTaskId: number,
  appWorkspaceRoot: string
): number | null {
  const verifier = getTask(verifierTaskId);
  if (!verifier || verifier.role !== "verifier") return null;
  const parent = verifier.parent_task_id ? getTask(verifier.parent_task_id) : undefined;
  const job = getJob(verifier.job_id);
  const parsed = readVerifierArtifact(verifier.id);
  if (!job || !parent || parent.role !== "implementer" || !parent.worktree_path || !parsed?.passed) return null;
  if (isWrapupTask(parent.scope_json)) return null;

  const existingWrapup = listTasksForJob(verifier.job_id).find(
    (candidate) => candidate.parent_task_id === verifier.id && candidate.role === "implementer" && isWrapupTask(candidate.scope_json)
  );
  if (existingWrapup) return existingWrapup.id;

  const wrapupPacket = WorkerPacketSchema.parse({
    workflow_phase: "wrapup",
    area: "cleanup, docs, PR handoff, memory",
    contract_json: {
      inputs: ["verification_result"],
      outputs: ["candidate_patch"],
      file_ownership: ["**/*"],
      acceptance_criteria: [
        "Clean up obvious code issues that are low-risk and improve maintainability",
        "Update relevant README or project docs for the delivered change",
        "Write durable project memory notes if useful lessons emerged",
        "If possible, leave the branch in PR-ready shape and create a PR",
      ],
      non_goals: [
        "Do not start a new feature branch unrelated to the completed task",
        "Do not rewrite stable code just for style churn",
      ],
    },
    acceptance_criteria: [
      "Clean up obvious code issues that are low-risk and improve maintainability",
      "Update relevant README or project docs for the delivered change",
      "Write durable project memory notes if useful lessons emerged",
      "If possible, leave the branch in PR-ready shape and create a PR",
    ],
    non_goals: [
      "Do not start a new feature branch unrelated to the completed task",
      "Do not rewrite stable code just for style churn",
    ],
    constraints: [
      "Prefer small, high-leverage cleanup and documentation updates",
      "Use the existing implementation branch/worktree rather than starting over",
    ],
    commands_allowed: [
      "npm test",
      "npm run build",
      "git status",
      "git add",
      "git commit",
      "git push",
      "gh pr create",
    ],
    success_criteria: [
      "Code and docs are polished enough for handoff",
      "Useful memory has been persisted",
      "PR created, or blocker documented precisely if PR creation was not possible",
    ],
  });

  const wrapupTaskId = insertTask({
    job_id: verifier.job_id,
    parent_task_id: verifier.id,
    kind: "patch_writer",
    role: "implementer",
    goal: buildWrapupGoal(parent.goal),
    scope_json: JSON.stringify(wrapupPacket),
    status: "queued",
    priority: Math.max(parent.priority + 1, 230),
    assigned_model_provider: parent.assigned_model_provider,
    write_mode: "worktree",
    workspace_repo_mode: "isolated_worktree",
    scratchpad_path: "",
    worktree_path: parent.worktree_path,
    git_branch: parent.git_branch,
    base_ref: parent.git_branch || parent.base_ref,
    runtime_json: parent.runtime_json || "{}",
    max_steps: Math.max(12, Math.min(parent.max_steps, 24)),
    max_tokens: Math.max(48_000, Math.min(parent.max_tokens, 120_000)),
    current_action: "wrapup_requested",
    next_action: "start",
    blocker: "",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: JSON.stringify([verifier.id]),
    allowed_tools_json: parent.allowed_tools_json || JSON.stringify(PATCH_TOOLS),
    artifact_type: "candidate_patch",
  });
  const sp = scratchpadPath(appWorkspaceRoot, verifier.job_id, wrapupTaskId);
  updateTask(wrapupTaskId, { scratchpad_path: sp });
  ensureScratchpad(sp);
  insertEvent({
    job_id: verifier.job_id,
    task_id: wrapupTaskId,
    level: "info",
    type: "wrapup_task_spawned",
    message: `Spawned wrap-up implementer from verifier ${verifier.id}`,
    data_json: JSON.stringify({ verifierTaskId: verifier.id, worktreePath: parent.worktree_path }),
  });
  return wrapupTaskId;
}

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

  private async bootstrapTaskRuntime(taskId: number): Promise<boolean> {
    const task = getTask(taskId);
    const job = task ? getJob(task.job_id) : undefined;
    if (!task || !job) return false;
    if (task.kind === "root" || task.role === "manager") return true;
    if (!["implementer", "verifier"].includes(task.role)) return true;

    const currentRuntime = parseTaskRuntime(task.runtime_json);
    if (currentRuntime.mode === "docker" && currentRuntime.status === "running") return true;

    const worktreePath = task.worktree_path || job.repo_path;
    const runtime = await startBestEffortTaskRuntime({
      jobId: task.job_id,
      taskId: task.id,
      repoPath: job.repo_path,
      worktreePath,
    });
    updateTask(task.id, { runtime_json: stringifyTaskRuntime(runtime) });

    if (runtime.mode === "docker" && runtime.status === "running") {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "info",
        type: "runtime_ready",
        message: `Docker runtime ready (${runtime.strategy})`,
        data_json: JSON.stringify(runtime),
      });
      return true;
    }

    insertEvent({
      job_id: task.job_id,
      task_id: task.id,
      level: runtime.status === "failed" ? "warn" : "info",
      type: "runtime_unavailable",
      message: runtime.lastError || "No task runtime available; continuing on the host",
      data_json: JSON.stringify(runtime),
    });
    return true;
  }

  private cleanupTaskRuntime(taskId: number): void {
    const task = getTask(taskId);
    const job = task ? getJob(task.job_id) : undefined;
    if (!task || !job) return;
    const runtime = parseTaskRuntime(task.runtime_json);
    if (runtime.mode !== "docker") return;
    stopTaskRuntime(runtime, task.worktree_path || job.repo_path);
    updateTask(task.id, {
      runtime_json: stringifyTaskRuntime({ ...runtime, status: "stopped", lastError: "" }),
    });
    insertEvent({
      job_id: task.job_id,
      task_id: task.id,
      level: "info",
      type: "runtime_stopped",
      message: "Stopped task runtime",
      data_json: JSON.stringify(runtime),
    });
  }

  private ensureTaskWorkspace(taskId: number): boolean {
    const task = getTask(taskId);
    const job = task ? getJob(task.job_id) : undefined;
    if (!task || !job) return false;
    const gitBootstrap = ensureGitRepo(job.repo_path);
    if (!gitBootstrap.ok) {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "error",
        type: "git_bootstrap_failed",
        message: gitBootstrap.message,
      });
      updateTask(task.id, { status: "failed", blocker: gitBootstrap.message });
      return false;
    }
    if (gitBootstrap.initialized) {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "info",
        type: "git_bootstrap",
        message: gitBootstrap.message,
      });
    }
    if (task.write_mode !== "worktree") return true;
    if (task.worktree_path) return true;

    const headBootstrap = ensureHeadCommit(job.repo_path);
    if (!headBootstrap.ok) {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "error",
        type: "git_head_failed",
        message: headBootstrap.message,
      });
      updateTask(task.id, { status: "failed", blocker: headBootstrap.message });
      return false;
    }
    if (headBootstrap.createdInitialCommit) {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "info",
        type: "git_initial_commit",
        message: headBootstrap.message,
        data_json: JSON.stringify({ headRef: headBootstrap.headRef }),
      });
    }

    const worktreePath = defaultWorktreePath(this.appWorkspaceRoot, task.job_id, task.id);
    const baseRef = task.base_ref || headBootstrap.headRef || defaultBranchName(job.repo_path) || "HEAD";
    const branch = `grist-task-${task.job_id}-${task.id}-${Date.now()}`;
    const res = createWorktree(job.repo_path, worktreePath, baseRef, branch);
    if (!res.ok) {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "error",
        type: "worktree_failed",
        message: res.stderr,
      });
      updateTask(task.id, { status: "failed", blocker: res.stderr });
      return false;
    }

    const scratchpad = task.scratchpad_path || scratchpadPath(this.appWorkspaceRoot, task.job_id, task.id);
    updateTask(task.id, {
      worktree_path: worktreePath,
      scratchpad_path: scratchpad,
      git_branch: branch,
      base_ref: baseRef,
      runtime_json: "{}",
      current_action: "workspace_ready",
    });
    ensureScratchpad(scratchpad);
    insertEvent({
      job_id: task.job_id,
      task_id: task.id,
      level: "info",
      type: "worktree_ready",
      message: `Isolated worktree ${worktreePath}`,
      data_json: JSON.stringify({ branch, baseRef }),
    });
    return true;
  }

  private enforceCompletedTaskContract(taskId: number): { ok: true } | { ok: false; severity: "minor" | "major"; reason: string } {
    const task = getTask(taskId);
    const job = task ? getJob(task.job_id) : undefined;
    if (!task || !job || task.role !== "implementer" || !task.worktree_path) return { ok: true };
    const contract = taskContract(task);
    if (contract.file_ownership.length === 0 || contract.file_ownership.includes("**/*")) return { ok: true };
    const changed = listWorktreeSyncableChanges(job.repo_path, task.worktree_path);
    if (!changed.ok) {
      return { ok: false, severity: "major", reason: changed.stderr };
    }
    const violation = classifyContractViolation(contract.file_ownership, changed.files);
    if (!violation) return { ok: true };
    insertArtifact({
      job_id: task.job_id,
      task_id: task.id,
      type: "contract_violation",
      content_json: JSON.stringify(violation),
      confidence: violation.severity === "major" ? 0.95 : 0.75,
    });
    insertEvent({
      job_id: task.job_id,
      task_id: task.id,
      level: violation.severity === "major" ? "warn" : "info",
      type: "contract_violation",
      message: `${violation.severity} contract violation`,
      data_json: JSON.stringify(violation),
    });
    if (violation.severity === "major") {
      updateTask(task.id, {
        status: "failed",
        blocker: `Major contract violation: ${violation.violatingFiles.join(", ")}`,
      });
      return { ok: false, severity: "major", reason: violation.reason };
    }
    return { ok: false, severity: "minor", reason: violation.reason };
  }

  private requestReplan(jobId: number, taskId: number | null, reason: string): void {
    const existingReplans = countRequestedReplans(jobId);
    if (!shouldReplan({
      repairAttempts: MAX_REPAIR_ATTEMPTS,
      majorContractViolation: true,
      integrationFailure: false,
      budgetExhausted: false,
      dependencyMismatch: false,
      existingReplans,
    })) {
      return;
    }
    for (const task of listTasksForJob(jobId)) {
      if (["queued", "ready", "running", "blocked", "paused"].includes(task.status) && task.kind !== "root") {
        updateTask(task.id, { status: "superseded", blocker: "Superseded by replan" });
      }
    }
    insertEvent({
      job_id: jobId,
      task_id: taskId,
      level: "warn",
      type: "replan_requested",
      message: reason,
    });
    updateJob(jobId, { status: "planning" });
    void this.planJob(jobId).catch((error) => {
      insertEvent({
        job_id: jobId,
        task_id: taskId,
        level: "error",
        type: "replan_failed",
        message: String(error),
      });
      updateJob(jobId, { status: "failed" });
    });
  }

  private maybeSpawnRoleFollowups(taskId: number): void {
    const task = getTask(taskId);
    if (!task) return;

    if (task.role === "implementer" && task.status === "done") {
      const contractCheck = this.enforceCompletedTaskContract(task.id);
      if (!contractCheck.ok && contractCheck.severity === "major") {
        this.requestReplan(task.job_id, task.id, contractCheck.reason);
        return;
      }
      const existingVerifier = listTasksForJob(task.job_id).find(
        (candidate) => candidate.parent_task_id === task.id && candidate.role === "verifier"
      );
      if (!existingVerifier) {
        const verifierId = this.spawnVerifierTask(task.job_id, task.id);
        if (verifierId) {
          this.emit("verifier_spawned", task.job_id, verifierId, { parentTaskId: task.id });
        }
      }
    }

    if (task.role === "verifier" && task.status === "done") {
      const verifierArtifact = readVerifierArtifact(task.id);
      if (verifierArtifact?.passed) {
        applyVerifiedWorktreeToRepo(task.id);
        const parent = task.parent_task_id ? getTask(task.parent_task_id) : undefined;
        if (parent?.role === "implementer") {
          void maybePersistReflection(parent.id, task.id).catch(() => {});
        }
        const wrapupTaskId = spawnWrapupTaskForVerifier(task.id, this.appWorkspaceRoot);
        if (wrapupTaskId) {
          this.emit("wrapup_spawned", task.job_id, wrapupTaskId, { parentTaskId: task.id });
        }
      } else {
        const repairTaskId = spawnAutoRepairTaskForVerifier(task.id, this.appWorkspaceRoot);
        if (repairTaskId) {
          this.emit("repair_spawned", task.job_id, repairTaskId, { parentTaskId: task.id });
        } else if (shouldReplan({
          repairAttempts: MAX_REPAIR_ATTEMPTS,
          majorContractViolation: false,
          integrationFailure: true,
          budgetExhausted: false,
          dependencyMismatch: false,
          existingReplans: countRequestedReplans(task.job_id),
        })) {
          this.requestReplan(task.job_id, task.id, "Verifier failed after repair budget was exhausted");
        }
      }
    }
  }

  private extendTaskBudgetForExplicitResume(taskId: number, source: "enqueue" | "resume_all"): void {
    const task = getTask(taskId);
    if (!task) return;
    const patch = explicitResumeBudgetPatch(task);
    updateTask(taskId, {
      max_steps: patch.max_steps,
      max_tokens: patch.max_tokens,
    });
    insertEvent({
      job_id: task.job_id,
      task_id: taskId,
      level: "info",
      type: "budget_extended",
      message: `Explicit resume added ${patch.stepBump} steps and ${patch.tokenBump.toLocaleString()} tokens`,
      data_json: JSON.stringify({
        source,
        stepBump: patch.stepBump,
        tokenBump: patch.tokenBump,
        maxSteps: patch.max_steps,
        maxTokens: patch.max_tokens,
      }),
    });
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
    ensureGristDir(input.repoPath);
    ensureGitRepo(input.repoPath);
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

  async planJob(jobId: number): Promise<void> {
    const job = getJob(jobId);
    if (!job) return;
    await runPlanner(job, this.appWorkspaceRoot);
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
          const p = (async () => {
            if (!this.ensureTaskWorkspace(taskId)) return;
            await this.bootstrapTaskRuntime(taskId);
            await runTaskWorker(taskId, ac.signal, this.appWorkspaceRoot, (msg) => {
              this.emit("duplicate_hint", jobId, taskId, { msg });
            }, (kind, jId, tId, data) => {
              this.emit(kind, jId, tId, data);
            });
          })()
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
              this.cleanupTaskRuntime(taskId);
              this.maybeSpawnRoleFollowups(taskId);
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
    const headBootstrap = ensureHeadCommit(job.repo_path);
    if (!headBootstrap.ok) return null;
    const branch = `grist-patch-${Date.now()}`;
    const id = insertTask({
      job_id: jobId,
      parent_task_id: null,
      kind: "patch_writer",
      role: "implementer",
      goal,
      scope_json: JSON.stringify({
        contract_json: {
          inputs: [],
          outputs: ["candidate_patch"],
          file_ownership: ["**/*"],
          acceptance_criteria: [],
          non_goals: [],
        },
      }),
      status: "queued",
      priority: 50,
      assigned_model_provider: job.default_model_provider as ModelProviderName,
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "",
      worktree_path: null,
      git_branch: "",
      base_ref: "",
      runtime_json: "{}",
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
    const res = createWorktree(job.repo_path, wt, headBootstrap.headRef || defaultBranchName(job.repo_path) || "HEAD", branch);
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
    updateTask(id, {
      worktree_path: wt,
      scratchpad_path: sp,
      git_branch: branch,
      base_ref: headBootstrap.headRef || defaultBranchName(job.repo_path) || "HEAD",
      runtime_json: "{}",
    });
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
      scope_json: JSON.stringify({
        patchTaskId,
        contract_json: {
          inputs: ["candidate_patch"],
          outputs: ["verification_result"],
          file_ownership: [],
          acceptance_criteria: ["Run the relevant validation commands and report pass/fail evidence"],
          non_goals: ["Do not silently expand implementation scope"],
        },
      }),
      status: "queued",
      priority: 200,
      assigned_model_provider: job.verifier_model_provider as ModelProviderName,
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "",
      worktree_path: patch.worktree_path,
      git_branch: patch.git_branch,
      base_ref: patch.base_ref,
      runtime_json: "{}",
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
      this.cleanupTaskRuntime(a.taskId);
      updateTask(a.taskId, { status: "stopped" });
      this.emit("task_stopped", undefined, a.taskId);
      return;
    }
    if (a.type === "redirect") {
      const t0 = getTask(a.taskId);
      if (!t0) return;
      if (t0.status === "running") {
        insertEvent({
          job_id: t0.job_id,
          task_id: a.taskId,
          level: "info",
          type: "task_redirect_deferred",
          message: a.newGoal.slice(0, 200),
        });
        return;
      }
      if (a.newScopeJson != null) {
        try {
          parseWorkerPacket(a.newScopeJson);
        } catch (error) {
          insertEvent({
            job_id: t0.job_id,
            task_id: a.taskId,
            level: "warn",
            type: "task_redirect_rejected",
            message: String(error),
          });
          return;
        }
      }
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
        this.extendTaskBudgetForExplicitResume(a.taskId, "enqueue");
        updateTask(a.taskId, { status: "queued", blocker: "" });
      }
      return;
    }
    if (a.type === "fork") {
      const t = getTask(a.taskId);
      const job = t ? getJob(t.job_id) : undefined;
      if (!t || !job) return;
      const nextPacket = a.newScopeJson != null ? parseWorkerPacket(a.newScopeJson) : parseWorkerPacket(t.scope_json);
      const forkCheck = canSafelyForkTask(t.id, nextPacket);
      if (!forkCheck.ok) {
        insertEvent({
          job_id: t.job_id,
          task_id: t.id,
          level: "warn",
          type: "task_fork_rejected",
          message: forkCheck.reason,
        });
        return;
      }
      const nid = insertTask({
        job_id: t.job_id,
        parent_task_id: a.stopOriginal ? null : t.id,
        kind: t.kind,
        role: t.role,
        goal: a.newGoal,
        scope_json: a.newScopeJson ?? t.scope_json,
        status: "queued",
        priority: t.priority - 1,
        assigned_model_provider: t.assigned_model_provider,
        write_mode: t.write_mode,
        workspace_repo_mode: t.workspace_repo_mode,
        scratchpad_path: "",
        worktree_path: t.write_mode === "worktree" ? null : t.worktree_path,
        git_branch: "",
        base_ref: t.base_ref,
        runtime_json: "{}",
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
        if (t.status === "paused") {
          this.extendTaskBudgetForExplicitResume(t.id, "resume_all");
          updateTask(t.id, { status: "queued", blocker: "" });
        }
      }
      return;
    }
    if (a.type === "stop_run") {
      this.stopScheduler(a.jobId);
      updateJob(a.jobId, { status: "stopped" });
      for (const t of listTasksForJob(a.jobId)) {
        this.cleanupTaskRuntime(t.id);
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

  taskEvents(jobId: number, taskId: number) {
    return listEventsForTask(jobId, taskId, 500);
  }

  jobLevelEvents(jobId: number) {
    return listJobLevelEvents(jobId, 500);
  }

  cleanupAllRuntimes(): void {
    for (const job of listJobs()) {
      for (const task of listTasksForJob(job.id)) {
        this.cleanupTaskRuntime(task.id);
      }
    }
  }

  listAllJobs() {
    return listJobs();
  }
}
