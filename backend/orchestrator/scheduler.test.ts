import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase, resetDbSingleton } from "../db/db.js";
import { insertJob } from "../db/jobRepo.js";
import { insertTask, updateTask, listTasksForJob } from "../db/taskRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { depsSatisfied, terminalJobOutcome } from "./scheduler.js";
import type { TaskRow } from "../db/taskRepo.js";

describe("depsSatisfied", () => {
  it("returns true when no dependencies", () => {
    const t = { dependencies_json: "[]" } as TaskRow;
    expect(depsSatisfied(t, new Map())).toBe(true);
  });

  it("requires all deps done", () => {
    const t = { dependencies_json: "[1,2]" } as TaskRow;
    const m = new Map<number, TaskRow>([
      [1, { status: "done" } as TaskRow],
      [2, { status: "running" } as TaskRow],
    ]);
    expect(depsSatisfied(t, m)).toBe(false);
    m.set(2, { status: "done" } as TaskRow);
    expect(depsSatisfied(t, m)).toBe(true);
  });
});

describe("sqlite tasks", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("inserts job and tasks with foreign keys", () => {
    const jid = insertJob({
      repo_path: "/tmp/r",
      user_goal: "test",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const tid = insertTask({
      job_id: jid,
      parent_task_id: null,
      kind: "analysis",
      role: "r",
      goal: "g",
      scope_json: "{}",
      status: "blocked",
      priority: 1,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/s",
      worktree_path: null,
      git_branch: "",
      base_ref: "",
      runtime_json: "{}",
      max_steps: 5,
      max_tokens: 100,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: "[]",
      artifact_type: "",
    });
    expect(tid).toBeGreaterThan(0);
    updateTask(tid, { status: "queued" });
    const rows = listTasksForJob(jid);
    expect(rows[0]?.status).toBe("queued");
  });
});

describe("terminalJobOutcome", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("treats summarizer/verifier failure as warnings when implementer succeeded", () => {
    const tasks = [
      { id: 1, kind: "patch_writer", role: "implementer", status: "done" },
      { id: 2, kind: "verifier", role: "verifier", status: "failed" },
      { id: 3, kind: "reducer", role: "summarizer", status: "failed" },
    ] as TaskRow[];

    expect(terminalJobOutcome(1, tasks)).toEqual({
      status: "completed",
      softFailedTaskIds: [2, 3],
    });
  });

  it("still fails when an implementer fails", () => {
    const tasks = [
      { id: 1, kind: "patch_writer", role: "implementer", status: "failed" },
      { id: 2, kind: "analysis", role: "scout", status: "done" },
    ] as TaskRow[];

    expect(terminalJobOutcome(1, tasks)).toEqual({
      status: "failed",
      softFailedTaskIds: [],
    });
  });

  it("fails when the latest relevant verifier result is still failing", () => {
    const jobId = insertJob({
      repo_path: "/tmp/r",
      user_goal: "test",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const implementerId = insertTask({
      job_id: jobId,
      parent_task_id: null,
      kind: "patch_writer",
      role: "implementer",
      goal: "build",
      scope_json: "{}",
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/i.md",
      worktree_path: "/tmp/w",
      git_branch: "b1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 20,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: "[]",
      artifact_type: "candidate_patch",
    });
    const verifierId = insertTask({
      job_id: jobId,
      parent_task_id: implementerId,
      kind: "verifier",
      role: "verifier",
      goal: "verify",
      scope_json: "{}",
      status: "done",
      priority: 9,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/v.md",
      worktree_path: "/tmp/w",
      git_branch: "b1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementerId]),
      allowed_tools_json: "[]",
      artifact_type: "verification_result",
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifierId,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: false,
        checks: [],
        tests_run: [],
        failures: ["still broken"],
        failing_logs_summary: "",
        likely_root_cause: "",
        summary: "broken",
        confidence: 0.5,
        recommended_next_action: "repair",
      }),
      confidence: 0.5,
    });

    const tasks = listTasksForJob(jobId);
    expect(terminalJobOutcome(jobId, tasks)).toEqual({
      status: "failed",
      softFailedTaskIds: [],
    });
  });

  it("ignores a failed verifier once a descendant repair verifier passes", () => {
    const jobId = insertJob({
      repo_path: "/tmp/r",
      user_goal: "test",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const implementer1 = insertTask({
      job_id: jobId,
      parent_task_id: null,
      kind: "patch_writer",
      role: "implementer",
      goal: "build",
      scope_json: "{}",
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/i1.md",
      worktree_path: "/tmp/w1",
      git_branch: "b1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 20,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: "[]",
      artifact_type: "candidate_patch",
    });
    const verifier1 = insertTask({
      job_id: jobId,
      parent_task_id: implementer1,
      kind: "verifier",
      role: "verifier",
      goal: "verify 1",
      scope_json: "{}",
      status: "done",
      priority: 9,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/v1.md",
      worktree_path: "/tmp/w1",
      git_branch: "b1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementer1]),
      allowed_tools_json: "[]",
      artifact_type: "verification_result",
    });
    const implementer2 = insertTask({
      job_id: jobId,
      parent_task_id: verifier1,
      kind: "patch_writer",
      role: "implementer",
      goal: "repair",
      scope_json: "{}",
      status: "done",
      priority: 8,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/i2.md",
      worktree_path: "/tmp/w2",
      git_branch: "b2",
      base_ref: "b1",
      runtime_json: "{}",
      max_steps: 20,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([verifier1]),
      allowed_tools_json: "[]",
      artifact_type: "candidate_patch",
    });
    const verifier2 = insertTask({
      job_id: jobId,
      parent_task_id: implementer2,
      kind: "verifier",
      role: "verifier",
      goal: "verify 2",
      scope_json: "{}",
      status: "done",
      priority: 7,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/v2.md",
      worktree_path: "/tmp/w2",
      git_branch: "b2",
      base_ref: "b1",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 1000,
      current_action: "",
      next_action: "",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementer2]),
      allowed_tools_json: "[]",
      artifact_type: "verification_result",
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifier1,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: false, checks: [], tests_run: [], failures: ["broken"], failing_logs_summary: "", likely_root_cause: "", summary: "broken", confidence: 0.5, recommended_next_action: "repair",
      }),
      confidence: 0.5,
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifier2,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: true, checks: [], tests_run: [], failures: [], failing_logs_summary: "", likely_root_cause: "", summary: "fixed", confidence: 0.8, recommended_next_action: "done",
      }),
      confidence: 0.8,
    });

    const tasks = listTasksForJob(jobId);
    expect(terminalJobOutcome(jobId, tasks)).toEqual({
      status: "completed",
      softFailedTaskIds: [],
    });
  });
});
