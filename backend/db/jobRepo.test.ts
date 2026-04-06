import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, closeDatabase, resetDbSingleton } from "./db.js";
import { insertJob, getJob, updateJob, addJobTokenUsage } from "./jobRepo.js";

describe("jobRepo", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("inserts and retrieves job", () => {
    const id = insertJob({
      repo_path: "/tmp/r",
      user_goal: "fix tests",
      operator_notes: "minimal",
      status: "draft",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const j = getJob(id);
    expect(j?.user_goal).toBe("fix tests");
    expect(j?.operator_notes).toBe("minimal");
    expect(j?.total_tokens_used).toBe(0);
  });

  it("updateJob patches fields", () => {
    const id = insertJob({
      repo_path: "/r",
      user_goal: "g",
      operator_notes: "",
      status: "draft",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    updateJob(id, { status: "running", operator_notes: "n2" });
    const j = getJob(id);
    expect(j?.status).toBe("running");
    expect(j?.operator_notes).toBe("n2");
  });

  it("addJobTokenUsage accumulates", () => {
    const id = insertJob({
      repo_path: "/r",
      user_goal: "g",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    addJobTokenUsage(id, 100, 0.01);
    addJobTokenUsage(id, 50, 0.02);
    const j = getJob(id);
    expect(j?.total_tokens_used).toBe(150);
    expect(j?.total_estimated_cost).toBeCloseTo(0.03, 5);
  });
});
