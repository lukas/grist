import { describe, expect, it } from "vitest";
import { __plannerInternals } from "./planner.js";
import type { ManagerPlan } from "../types/taskState.js";

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
});
