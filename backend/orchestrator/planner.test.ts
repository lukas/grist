import { describe, expect, it } from "vitest";
import { __plannerInternals } from "./planner.js";
import type { ManagerPlan } from "../types/taskState.js";

function contract(fileOwnership: string[], outputs: string[], inputs: string[] = []) {
  return {
    inputs,
    outputs,
    file_ownership: fileOwnership,
    acceptance_criteria: [],
    non_goals: [],
  };
}

describe("planner greenfield guardrails", () => {
  it("collapses empty-repo multi-implementer plans into one writer", () => {
    const plan: ManagerPlan = {
      reasoning: "Split work between core logic and UI.",
      accepted_assumptions: [],
      parallelism_notes: ["Two writers can move faster."],
      tasks: [
        {
          role: "implementer",
          goal: "Create the TypeScript project scaffold and core game logic.",
          packet: {
            files: ["package.json", "tsconfig.json", "src/game.ts"],
            area: "core",
            workflow_phase: "",
            contract_json: contract(["package.json", "tsconfig.json", "src/game.ts"], ["candidate_patch"]),
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
          max_steps: 20,
          depends_on: [],
        },
        {
          role: "implementer",
          goal: "Create the CLI UI and AI player.",
          packet: {
            files: ["src/ui.ts", "src/ai.ts", "src/index.ts"],
            area: "ui",
            workflow_phase: "",
            contract_json: contract(["src/ui.ts", "src/ai.ts", "src/index.ts"], ["candidate_patch"]),
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
          max_steps: 20,
          depends_on: [],
        },
      ],
    };

    const adjusted = __plannerInternals.validateParallelism(
      plan,
      "Build a CLI backgammon game in TypeScript.",
      true,
      0,
    );

    expect(adjusted.tasks.filter((task) => task.role === "implementer")).toHaveLength(1);
    expect(adjusted.tasks.some((task) => task.role === "summarizer")).toBe(true);
    expect(adjusted.reasoning).toContain("Collapsed 2 greenfield implementers into one");
    expect(adjusted.parallelism_notes.join(" ")).toContain("single writer task");
  });

  it("injects empty-repo guidance into the planner prompt", () => {
    const prompt = __plannerInternals.buildPlannerPrompt(
      "Build a CLI backgammon game in TypeScript.",
      "",
      [],
      true,
    );

    expect(prompt.system).toContain("Empty-repo guidance:");
    expect(prompt.system).toContain("Default to exactly one implementer");
    expect(prompt.system).toContain("runnable vertical slice");
  });

  it("bumps greenfield implementer step budgets to reduce repair churn", () => {
    const plan: ManagerPlan = {
      reasoning: "One writer is enough.",
      accepted_assumptions: [],
      parallelism_notes: [],
      tasks: [
        {
          role: "implementer",
          goal: "Build the chess app.",
          packet: {
            files: [],
            area: "app",
            workflow_phase: "",
            contract_json: contract(["**/*"], ["candidate_patch"]),
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
          max_steps: 20,
          depends_on: [],
        },
      ],
    };

    const adjusted = __plannerInternals.validateParallelism(plan, "Build a chess app.", true, 0);

    expect(adjusted.tasks[0]?.max_steps).toBe(40);
  });

  it("drops scout tasks in empty repos to save wall-clock time", () => {
    const plan: ManagerPlan = {
      reasoning: "Scout first, then implement.",
      accepted_assumptions: [],
      parallelism_notes: [],
      tasks: [
        {
          role: "scout",
          goal: "Inspect the repo.",
          packet: {
            files: [],
            area: "repo",
            workflow_phase: "",
            contract_json: contract([], ["findings_report"]),
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
          max_steps: 10,
          depends_on: [],
        },
        {
          role: "implementer",
          goal: "Build the chess app.",
          packet: {
            files: [],
            area: "app",
            workflow_phase: "",
            contract_json: contract(["**/*"], ["candidate_patch"], ["findings_report"]),
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
          max_steps: 20,
          depends_on: [0],
        },
      ],
    };

    const adjusted = __plannerInternals.validateParallelism(plan, "Build a chess app.", true, 0);

    expect(adjusted.tasks.some((task) => task.role === "scout")).toBe(false);
    expect(adjusted.tasks.some((task) => task.role === "implementer")).toBe(true);
  });
});
