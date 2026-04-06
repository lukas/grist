import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase, resetDbSingleton } from "../db/db.js";
import { insertJob } from "../db/jobRepo.js";
import { insertTask, updateTask, listTasksForJob } from "../db/taskRepo.js";
import { depsSatisfied } from "./scheduler.js";
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
