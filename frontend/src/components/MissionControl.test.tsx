import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MissionControl } from "./MissionControl";

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).window = globalThis;
  (window as unknown as Record<string, unknown>).grist = {
    getJob: vi.fn().mockResolvedValue({}),
  };
});

afterEach(() => cleanup());

function renderMC(overrides: Record<string, unknown> = {}) {
  const defaults = {
    repo: "/tmp/repo",
    goal: "find flaky tests",
    notes: "",
    jobId: null,
    tick: 0,
    onGoalChange: vi.fn(),
    onNotesChange: vi.fn(),
    provider: "mock",
    onPickRepo: vi.fn(),
    onCreateRun: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<MissionControl {...props} />), props };
}

describe("MissionControl Enter key", () => {
  it("calls onCreateRun when Enter pressed in goal field", () => {
    const { props } = renderMC({ repo: "/tmp/repo", goal: "hello" });
    const goalInput = screen.getByPlaceholderText("Goal…");
    fireEvent.keyDown(goalInput, { key: "Enter" });
    expect(props.onCreateRun).toHaveBeenCalledTimes(1);
  });

  it("calls onCreateRun when Enter pressed in notes field", () => {
    const { props } = renderMC({ repo: "/tmp/repo", goal: "hello" });
    const notesInput = screen.getByPlaceholderText("Notes…");
    fireEvent.keyDown(notesInput, { key: "Enter" });
    expect(props.onCreateRun).toHaveBeenCalledTimes(1);
  });

  it("calls onCreateRun even without repo (parent handles repo picker)", () => {
    const { props } = renderMC({ repo: "", goal: "hello" });
    const goalInput = screen.getByPlaceholderText("Goal…");
    fireEvent.keyDown(goalInput, { key: "Enter" });
    expect(props.onCreateRun).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onCreateRun when goal is blank", () => {
    const { props } = renderMC({ repo: "/tmp/repo", goal: "  " });
    const goalInput = screen.getByPlaceholderText("Goal…");
    fireEvent.keyDown(goalInput, { key: "Enter" });
    expect(props.onCreateRun).not.toHaveBeenCalled();
  });

  it("does NOT call onCreateRun on a non-Enter key", () => {
    const { props } = renderMC({ repo: "/tmp/repo", goal: "hello" });
    const goalInput = screen.getByPlaceholderText("Goal…");
    fireEvent.keyDown(goalInput, { key: "a" });
    expect(props.onCreateRun).not.toHaveBeenCalled();
  });
});
