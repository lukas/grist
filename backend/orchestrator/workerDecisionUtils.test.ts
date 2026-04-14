import { describe, expect, it } from "vitest";
import {
  normalizeWorkerDecisionCandidate,
  tryParseModelJson,
} from "./workerDecisionUtils.js";

describe("workerDecisionUtils", () => {
  it("normalizes legacy write_artifact decisions", () => {
    const normalized = normalizeWorkerDecisionCandidate({
      decision: "write_artifact",
      type: "findings_report",
      content: { relevant_files: ["README.md"] },
      reasoning: "done",
    });

    expect(normalized.decision).toBe("finish");
    expect(normalized.reasoning_summary).toBe("done");
    expect(normalized.artifact).toEqual({
      type: "findings_report",
      content: { relevant_files: ["README.md"] },
    });
  });

  it("parses embedded json when possible", () => {
    const parsed = tryParseModelJson('bad preface {"decision":"call_tool","tool_name":"list_files","tool_args":{}} trailing') as {
      decision: string;
      tool_name: string;
    };
    expect(parsed.decision).toBe("call_tool");
    expect(parsed.tool_name).toBe("list_files");
  });
});
