import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, resetDbSingleton } from "../db/db.js";
import { insertJob, getJob } from "../db/jobRepo.js";
import { getTask, insertTask, listTasksForJob } from "../db/taskRepo.js";
import { listEventsByTaskId } from "../db/eventRepo.js";
import { GristOrchestrator, explicitResumeBudgetPatch } from "./appOrchestrator.js";

function createPausedTask(jobId: number, role = "worker"): number {
  return insertTask({
    job_id: jobId,
    parent_task_id: null,
    kind: "analysis",
    role,
    goal: "continue work",
    scope_json: "{}",
    status: "paused",
    priority: 1,
    assigned_model_provider: "mock",
    write_mode: "none",
    workspace_repo_mode: "shared_read_only",
    scratchpad_path: "/tmp/scratchpad.md",
    worktree_path: null,
    git_branch: "",
    base_ref: "",
    runtime_json: "{}",
    max_steps: 8,
    max_tokens: 100000,
    current_action: "paused",
    next_action: "operator",
    blocker: "max_steps exceeded (8/8)",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: "[]",
    allowed_tools_json: "[]",
    artifact_type: "",
  });
}

describe("explicitResumeBudgetPatch", () => {
  it("adds step and token headroom", () => {
    expect(explicitResumeBudgetPatch({ max_steps: 5, max_tokens: 100000 })).toEqual({
      max_steps: 10,
      max_tokens: 150000,
      stepBump: 5,
      tokenBump: 50000,
    });
  });
});

describe("resume budget extension", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("extends budget when enqueueing a paused task", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "test",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const taskId = createPausedTask(jobId);
    const orchestrator = new GristOrchestrator("/tmp/workspace");

    orchestrator.taskControl({ type: "enqueue", taskId });

    const task = getTask(taskId);
    expect(task?.status).toBe("queued");
    expect(task?.blocker).toBe("");
    expect(task?.max_steps).toBe(13);
    expect(task?.max_tokens).toBe(150000);
    const events = listEventsByTaskId(taskId) as { type: string }[];
    expect(events.some((e) => e.type === "budget_extended")).toBe(true);
  });

  it("extends budget for paused tasks on resume_all", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "test",
      operator_notes: "",
      status: "paused",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    createPausedTask(jobId, "architect");
    createPausedTask(jobId, "implementer");
    const orchestrator = new GristOrchestrator("/tmp/workspace");

    orchestrator.jobControl({ type: "resume_all", jobId });

    expect(getJob(jobId)?.status).toBe("running");
    const tasks = listTasksForJob(jobId);
    expect(tasks.every((t) => t.status === "queued")).toBe(true);
    expect(tasks.every((t) => t.max_steps === 13)).toBe(true);
    expect(tasks.every((t) => t.max_tokens === 150000)).toBe(true);
  });
});
