import type { ModelProvider, ModelRequest, ModelResponse } from "../types/models.js";
import { extractJsonObject } from "./jsonExtract.js";

/**
 * Deterministic provider for tests and offline dev.
 * Cycles: list_files -> read_file README/package.json -> grep "function" -> finish findings_report.
 */
export class MockProvider implements ModelProvider {
  name = "mock" as const;
  private step = 0;

  async generateText(input: ModelRequest): Promise<ModelResponse> {
    const t = `mock:${input.userPrompt.slice(0, 40)}`;
    return {
      text: t,
      raw: t,
      tokensIn: 10,
      tokensOut: 20,
      estimatedCost: 0,
      finishReason: "stop",
    };
  }

  async generateStructured(input: ModelRequest): Promise<ModelResponse> {
    this.step += 1;
    const base = {
      reasoning_summary: `mock step ${this.step}`,
      expected_information_gain: 0.5,
      task_state_update: {
        current_action: `mock-${this.step}`,
        next_action: "continue",
        confidence: 0.5 + this.step * 0.05,
      },
    };

    let decision: Record<string, unknown>;
    if (this.step === 1) {
      decision = {
        ...base,
        decision: "call_tool",
        tool_name: "list_files",
        tool_args: { path: ".", recursive: false },
      };
    } else if (this.step === 2) {
      decision = {
        ...base,
        decision: "call_tool",
        tool_name: "read_file",
        tool_args: { path: "README.md" },
      };
    } else if (this.step === 3) {
      decision = {
        ...base,
        decision: "call_tool",
        tool_name: "grep_code",
        tool_args: { pattern: "import", scopePaths: ["."] },
      };
    } else {
      decision = {
        ...base,
        decision: "finish",
        artifact: {
          type: "findings_report",
          content: {
            summary: "Mock analysis complete",
            signals: ["README present", "imports found"],
          },
        },
        task_state_update: {
          ...base.task_state_update,
          new_findings: ["Mock finding: repository structure inspected"],
          new_open_questions: [],
        },
      };
    }

    const text = JSON.stringify(decision);
    return {
      text,
      parsedJson: decision,
      raw: text,
      tokensIn: 32,
      tokensOut: 64,
      estimatedCost: 0,
      finishReason: "stop",
    };
  }

  reset(): void {
    this.step = 0;
  }

  static parseFromText(input: ModelRequest, text: ModelResponse): ModelResponse {
    const parsed = extractJsonObject(text.text);
    return { ...text, parsedJson: parsed };
  }
}
