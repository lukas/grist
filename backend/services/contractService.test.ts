import { describe, expect, it } from "vitest";
import { classifyContractViolation, validatePlanContracts } from "./contractService.js";
import type { ManagerPlan } from "../types/taskState.js";

describe("contractService", () => {
  it("classifies same-area scope drift as minor", () => {
    const violation = classifyContractViolation(["src/game.ts"], ["src/ui.ts"]);
    expect(violation?.severity).toBe("minor");
  });

  it("classifies shared config drift as major", () => {
    const violation = classifyContractViolation(["src/game.ts"], ["package.json"]);
    expect(violation?.severity).toBe("major");
  });

  it("rejects dependency inputs that are not declared by producers", () => {
    const plan: ManagerPlan = {
      reasoning: "Test plan",
      accepted_assumptions: [],
      parallelism_notes: [],
      tasks: [
        {
          role: "scout",
          goal: "Scout",
          max_steps: 5,
          depends_on: [],
          packet: {
            files: [],
            area: "repo",
            workflow_phase: "",
            contract_json: {
              inputs: [],
              outputs: ["findings_report"],
              file_ownership: [],
              acceptance_criteria: [],
              non_goals: [],
            },
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
        },
        {
          role: "implementer",
          goal: "Implement",
          max_steps: 10,
          depends_on: [0],
          packet: {
            files: ["src/app.ts"],
            area: "app",
            workflow_phase: "",
            contract_json: {
              inputs: ["verification_result"],
              outputs: ["candidate_patch"],
              file_ownership: ["src/app.ts"],
              acceptance_criteria: [],
              non_goals: [],
            },
            acceptance_criteria: [],
            non_goals: [],
            similar_patterns: [],
            constraints: [],
            commands_allowed: [],
            success_criteria: [],
          },
        },
      ],
    };
    const validated = validatePlanContracts(plan);
    expect(validated.ok).toBe(false);
  });
});
