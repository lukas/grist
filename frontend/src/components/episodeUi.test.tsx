import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskList } from "./TaskList";
import { TaskDetail } from "./TaskDetail";

const rootTask: RootTaskSummary = {
  id: 100,
  user_goal: "Ship the feature",
  status: "running",
  repo_path: "/tmp/repo",
  created_at: "2026-04-14T00:00:00.000Z",
  updated_at: "2026-04-14T00:00:00.000Z",
};

const episodeTasks: ChildTask[] = [
  {
    id: 1,
    role: "implementer",
    kind: "patch_writer",
    status: "done",
    goal: "Implement the feature",
    assigned_model_provider: "mock",
    confidence: 0.7,
    tokens_used: 120,
    steps_used: 4,
    max_steps: 20,
    workspace_repo_mode: "isolated_worktree",
    findings_json: "[]",
    dependencies_json: "[]",
    parent_task_id: null,
    blocker: "",
    current_action: "finished",
    git_branch: "grist-task-1",
    base_ref: "main",
    runtime_json: "{}",
    episode_root_task_id: 1,
    episode_label: "Episode 1",
    episode_phase: "implement",
    episode_status: "running",
    episode_attempt: 1,
    episode_task_ids_json: "[1,2]",
    episode_is_root: true,
  },
  {
    id: 2,
    role: "verifier",
    kind: "verifier",
    status: "running",
    goal: "Verify the feature",
    assigned_model_provider: "mock",
    confidence: 0.5,
    tokens_used: 40,
    steps_used: 1,
    max_steps: 2,
    workspace_repo_mode: "shared_read_only",
    findings_json: "[]",
    dependencies_json: "[1]",
    parent_task_id: 1,
    blocker: "",
    current_action: "tests",
    git_branch: "grist-task-1",
    base_ref: "main",
    runtime_json: "{}",
    episode_root_task_id: 1,
    episode_label: "Episode 1",
    episode_phase: "verify",
    episode_status: "running",
    episode_attempt: 1,
    episode_task_ids_json: "[1,2]",
    episode_is_root: false,
  },
];

function installGristMocks() {
  Object.defineProperty(window, "grist", {
    configurable: true,
    value: {
      listRootTasks: vi.fn().mockResolvedValue([rootTask]),
      getChildTasks: vi.fn().mockResolvedValue(episodeTasks),
      getEventsForTask: vi.fn().mockResolvedValue([]),
      sendTaskMessage: vi.fn().mockResolvedValue(true),
      taskControl: vi.fn().mockResolvedValue(true),
      rootTaskControl: vi.fn().mockResolvedValue(true),
      logsDir: vi.fn().mockResolvedValue("/tmp/logs"),
      openPath: vi.fn().mockResolvedValue(""),
    } as unknown as Window["grist"],
  });
}

describe("episode UI", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    installGristMocks();
  });

  it("renders episode-first labels in the task tree", async () => {
    const onSelect = vi.fn();
    const onLoadRootTask = vi.fn();

    render(
      <TaskList
        repo="/tmp/repo"
        rootTaskId={100}
        tick={0}
        selectedId={null}
        onSelect={onSelect}
        onLoadRootTask={onLoadRootTask}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Episode 1")).toBeTruthy();
    });
    expect(screen.getByText("verify")).toBeTruthy();
    expect(screen.getAllByText("running").length).toBeGreaterThan(0);
  });

  it("lets the user switch phases within an episode from the detail view", async () => {
    const onSelectTask = vi.fn();
    const user = userEvent.setup();

    render(
      <TaskDetail
        rootTaskId={100}
        taskId={2}
        tick={0}
        onRefresh={() => {}}
        onSelectTask={onSelectTask}
      />,
    );

    const episodeButton = await screen.findByRole("button", { name: /episode 1/i });
    await user.click(episodeButton);
    expect(onSelectTask).toHaveBeenCalledWith(1);
    expect(screen.getByText("Episode flow")).toBeTruthy();
  });
});
