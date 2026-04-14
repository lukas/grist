import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { closeDatabase, openDatabase, resetDbSingleton } from "../db/db.js";
import { insertJob, getJob } from "../db/jobRepo.js";
import { getTask, insertTask, listTasksForJob } from "../db/taskRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { listEventsByTaskId } from "../db/eventRepo.js";
import {
  applyVerifiedWorktreeToRepo,
  GristOrchestrator,
  explicitResumeBudgetPatch,
  spawnAutoRepairTaskForVerifier,
  spawnWrapupTaskForVerifier,
} from "./appOrchestrator.js";

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

describe("verifier auto-repair followups", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("spawns a repair implementer from a failed verifier artifact", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "build app",
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
      goal: "Build a CLI app",
      scope_json: JSON.stringify({ files: ["package.json", "src/index.ts"] }),
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/impl.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(["write_file", "run_command_safe"]),
      artifact_type: "candidate_patch",
    });

    const verifierId = insertTask({
      job_id: jobId,
      parent_task_id: implementerId,
      kind: "verifier",
      role: "verifier",
      goal: "Verify patch",
      scope_json: JSON.stringify({ patchTaskId: implementerId }),
      status: "done",
      priority: 20,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/verifier.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.3,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementerId]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });

    insertArtifact({
      job_id: jobId,
      task_id: verifierId,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: false,
        checks: [{ name: "npm test", status: "failed", details: "Missing script: test" }],
        tests_run: ["npm test"],
        failures: ["Missing script: test"],
        failing_logs_summary: "npm error Missing script: test",
        likely_root_cause: "package.json does not define a test script",
        summary: "Implementation works but package.json is missing a test script.",
        confidence: 0.8,
        recommended_next_action: "Add a test script or adjust verification to the available commands.",
      }),
      confidence: 0.8,
    });

    const repairId = spawnAutoRepairTaskForVerifier(verifierId, "/tmp/workspace");
    const repair = repairId ? getTask(repairId) : undefined;

    expect(repairId).toBeTruthy();
    expect(repair?.role).toBe("implementer");
    expect(repair?.parent_task_id).toBe(verifierId);
    expect(repair?.base_ref).toBe("grist-task-1");
    expect(repair?.status).toBe("queued");
    expect(repair?.goal).toContain("Missing script: test");
    expect(repair?.goal).toContain("Add a test script");
  });

  it("does not spawn infinite repair chains past the cap", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "build app",
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
      goal: "Build app",
      scope_json: "{}",
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/i1.md",
      worktree_path: "/tmp/w1",
      git_branch: "branch-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(["write_file"]),
      artifact_type: "candidate_patch",
    });
    const verifier1 = insertTask({
      job_id: jobId,
      parent_task_id: implementer1,
      kind: "verifier",
      role: "verifier",
      goal: "Verify build app",
      scope_json: "{}",
      status: "done",
      priority: 20,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/v1.md",
      worktree_path: "/tmp/w1",
      git_branch: "branch-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.3,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementer1]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });
    const implementer2 = insertTask({
      job_id: jobId,
      parent_task_id: verifier1,
      kind: "patch_writer",
      role: "implementer",
      goal: "Repair build app",
      scope_json: "{}",
      status: "done",
      priority: 21,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/i2.md",
      worktree_path: "/tmp/w2",
      git_branch: "branch-2",
      base_ref: "branch-1",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([verifier1]),
      allowed_tools_json: JSON.stringify(["write_file"]),
      artifact_type: "candidate_patch",
    });
    const verifier2 = insertTask({
      job_id: jobId,
      parent_task_id: implementer2,
      kind: "verifier",
      role: "verifier",
      goal: "Verify repair",
      scope_json: "{}",
      status: "done",
      priority: 22,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/v2.md",
      worktree_path: "/tmp/w2",
      git_branch: "branch-2",
      base_ref: "branch-1",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.3,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementer2]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });

    insertArtifact({
      job_id: jobId,
      task_id: verifier2,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: false,
        checks: [],
        tests_run: ["npm test"],
        failures: ["still broken"],
        failing_logs_summary: "still broken",
        likely_root_cause: "needs manual intervention",
        summary: "Repair attempt still failed verification.",
        confidence: 0.5,
        recommended_next_action: "stop auto-retrying",
      }),
      confidence: 0.5,
    });

    const repairId = spawnAutoRepairTaskForVerifier(verifier2, "/tmp/workspace");

    expect(repairId).toBeNull();
    const events = listEventsByTaskId(verifier2) as { type: string }[];
    expect(events.some((event) => event.type === "repair_skipped")).toBe(true);
  });
});

describe("verifier wrap-up followups", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("spawns a wrap-up implementer after a passing verifier", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "build app",
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
      goal: "Build a CLI app",
      scope_json: JSON.stringify({}),
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/impl.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(["write_file", "run_command_safe", "write_memory"]),
      artifact_type: "candidate_patch",
    });
    const verifierId = insertTask({
      job_id: jobId,
      parent_task_id: implementerId,
      kind: "verifier",
      role: "verifier",
      goal: "Verify patch",
      scope_json: JSON.stringify({ patchTaskId: implementerId }),
      status: "done",
      priority: 20,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/verifier.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementerId]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifierId,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: true,
        checks: [{ name: "build", status: "passed", details: "ok" }],
        tests_run: ["npm run build"],
        failures: [],
        failing_logs_summary: "",
        likely_root_cause: "",
        summary: "Looks good.",
        confidence: 0.9,
        recommended_next_action: "wrap up docs and handoff",
      }),
      confidence: 0.9,
    });

    const wrapupId = spawnWrapupTaskForVerifier(verifierId, "/tmp/workspace");
    const wrapup = wrapupId ? getTask(wrapupId) : undefined;

    expect(wrapupId).toBeTruthy();
    expect(wrapup?.parent_task_id).toBe(verifierId);
    expect(wrapup?.worktree_path).toBe("/tmp/worktree-impl");
    expect(wrapup?.git_branch).toBe("grist-task-1");
    expect(wrapup?.goal).toContain("Clean up obvious rough edges");
    expect(wrapup?.scope_json).toContain("\"workflow_phase\":\"wrapup\"");
  });

  it("does not spawn wrap-up from an existing wrap-up chain", () => {
    const jobId = insertJob({
      repo_path: "/tmp/repo",
      user_goal: "build app",
      operator_notes: "",
      status: "running",
      selected_execution_mode: "local",
      default_model_provider: "mock",
      planner_model_provider: "mock",
      reducer_model_provider: "mock",
      verifier_model_provider: "mock",
    });
    const wrapupImplementerId = insertTask({
      job_id: jobId,
      parent_task_id: null,
      kind: "patch_writer",
      role: "implementer",
      goal: "Wrap up app",
      scope_json: JSON.stringify({ workflow_phase: "wrapup" }),
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "/tmp/impl.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(["write_file", "run_command_safe", "write_memory"]),
      artifact_type: "candidate_patch",
    });
    const verifierId = insertTask({
      job_id: jobId,
      parent_task_id: wrapupImplementerId,
      kind: "verifier",
      role: "verifier",
      goal: "Verify wrapup patch",
      scope_json: "{}",
      status: "done",
      priority: 20,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: "/tmp/verifier.md",
      worktree_path: "/tmp/worktree-impl",
      git_branch: "grist-task-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([wrapupImplementerId]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifierId,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: true,
        checks: [],
        tests_run: [],
        failures: [],
        failing_logs_summary: "",
        likely_root_cause: "",
        summary: "done",
        confidence: 0.9,
        recommended_next_action: "done",
      }),
      confidence: 0.9,
    });

    expect(spawnWrapupTaskForVerifier(verifierId, "/tmp/workspace")).toBeNull();
  });
});

describe("verified worktree apply", () => {
  beforeEach(() => {
    resetDbSingleton();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDbSingleton();
  });

  it("copies verified source changes back to the canonical repo and skips transient outputs", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "grist-apply-"));
    const repoPath = join(tempRoot, "repo");
    const worktreePath = join(tempRoot, "worktree");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    spawnSync("git", ["init"], { cwd: worktreePath, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreePath, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: worktreePath, encoding: "utf8" });
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src/index.ts"), "console.log('base');\n");
    spawnSync("git", ["add", "."], { cwd: worktreePath, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "base"], { cwd: worktreePath, encoding: "utf8" });

    writeFileSync(join(worktreePath, "src/index.ts"), "console.log('verified');\n");
    writeFileSync(join(worktreePath, "package.json"), "{\"name\":\"demo\"}\n");
    mkdirSync(join(worktreePath, "dist"), { recursive: true });
    writeFileSync(join(worktreePath, "dist/index.js"), "console.log('built');\n");
    mkdirSync(join(worktreePath, "node_modules"), { recursive: true });
    writeFileSync(join(worktreePath, "node_modules/left-pad.js"), "module.exports = {};\n");

    const jobId = insertJob({
      repo_path: repoPath,
      user_goal: "build app",
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
      goal: "Build app",
      scope_json: "{}",
      status: "done",
      priority: 10,
      assigned_model_provider: "mock",
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: join(tempRoot, "impl.md"),
      worktree_path: worktreePath,
      git_branch: "branch-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 24,
      max_tokens: 120000,
      current_action: "finished",
      next_action: "",
      blocker: "",
      confidence: 0.8,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: JSON.stringify(["write_file"]),
      artifact_type: "candidate_patch",
    });
    const verifierId = insertTask({
      job_id: jobId,
      parent_task_id: implementerId,
      kind: "verifier",
      role: "verifier",
      goal: "Verify app",
      scope_json: "{}",
      status: "done",
      priority: 20,
      assigned_model_provider: "mock",
      write_mode: "none",
      workspace_repo_mode: "shared_read_only",
      scratchpad_path: join(tempRoot, "verifier.md"),
      worktree_path: worktreePath,
      git_branch: "branch-1",
      base_ref: "main",
      runtime_json: "{}",
      max_steps: 2,
      max_tokens: 8000,
      current_action: "verified",
      next_action: "",
      blocker: "",
      confidence: 0.9,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify([implementerId]),
      allowed_tools_json: JSON.stringify(["run_tests"]),
      artifact_type: "verification_result",
    });
    insertArtifact({
      job_id: jobId,
      task_id: verifierId,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: true,
        checks: [{ name: "build", status: "passed", details: "ok" }],
        tests_run: ["npm run build"],
        failures: [],
        failing_logs_summary: "",
        likely_root_cause: "",
        summary: "verified",
        confidence: 0.9,
        recommended_next_action: "none",
      }),
      confidence: 0.9,
    });

    expect(applyVerifiedWorktreeToRepo(verifierId)).toBe(true);
    expect(readFileSync(join(repoPath, "src/index.ts"), "utf8")).toContain("verified");
    expect(readFileSync(join(repoPath, "package.json"), "utf8")).toContain("\"name\":\"demo\"");
    expect(() => readFileSync(join(repoPath, "dist/index.js"), "utf8")).toThrow();
    expect(() => readFileSync(join(repoPath, "node_modules/left-pad.js"), "utf8")).toThrow();

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
