import { describe, it, expect } from "vitest";
import { WorkerDecisionSchema } from "./taskState.js";

describe("WorkerDecisionSchema", () => {
  it("accepts minimal call_tool decision", () => {
    const d = WorkerDecisionSchema.parse({
      decision: "call_tool",
      reasoning_summary: "x",
      tool_name: "read_file",
      tool_args: { path: "a.txt" },
    });
    expect(d.tool_name).toBe("read_file");
  });

  it("accepts decision without reasoning_summary", () => {
    const d = WorkerDecisionSchema.parse({
      decision: "finish",
    });
    expect(d.reasoning_summary).toBe("");
  });

  it("rejects invalid decision enum", () => {
    expect(() =>
      WorkerDecisionSchema.parse({
        decision: "nope",
        reasoning_summary: "x",
      })
    ).toThrow();
  });
});
