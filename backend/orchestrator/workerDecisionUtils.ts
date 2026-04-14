import { extractJsonObject } from "../providers/jsonExtract.js";

export const WORKER_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  required: ["decision"],
  properties: {
    decision: {
      type: "string",
      enum: ["call_tool", "call_tools", "finish", "pause_self"],
    },
    reasoning_summary: { type: "string" },
    expected_information_gain: { type: "number" },
    tool_name: { type: "string" },
    tool_args: { type: "object" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        required: ["tool_name"],
        properties: {
          tool_name: { type: "string" },
          tool_args: { type: "object" },
        },
      },
    },
    artifact: {
      type: "object",
      required: ["type", "content"],
      properties: {
        type: { type: "string" },
        content: {},
      },
    },
    task_state_update: {
      type: "object",
      properties: {
        current_action: { type: "string" },
        next_action: { type: "string" },
        confidence: { type: "number" },
        new_findings: { type: "array" },
        new_open_questions: { type: "array" },
      },
    },
  },
};

export function tryParseModelJson(text: string): unknown | null {
  try {
    return extractJsonObject(text);
  } catch {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

export function normalizeWorkerDecisionCandidate(
  raw: unknown,
  fallbackArtifactType?: string,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = { ...(raw as Record<string, unknown>) };

  if (obj.tool && !obj.tool_name) obj.tool_name = obj.tool;
  if (obj.args && !obj.tool_args) obj.tool_args = obj.args;
  if (obj.reasoning && !obj.reasoning_summary) obj.reasoning_summary = obj.reasoning;

  if (obj.decision === "write_artifact") {
    obj.decision = "finish";
    if (!obj.artifact) {
      const type =
        (typeof obj.type === "string" && obj.type)
        || (typeof obj.artifact_type === "string" && obj.artifact_type)
        || fallbackArtifactType;
      const content =
        obj.content
        ?? obj.artifact_content
        ?? obj.data
        ?? {};
      if (type) {
        obj.artifact = { type, content };
      }
    }
  }

  if (obj.artifact && typeof obj.artifact === "object" && !Array.isArray(obj.artifact)) {
    const artifact = { ...(obj.artifact as Record<string, unknown>) };
    if (!artifact.type) {
      const type =
        (typeof artifact.artifact_type === "string" && artifact.artifact_type)
        || (typeof obj.type === "string" && obj.type)
        || (typeof obj.artifact_type === "string" && obj.artifact_type)
        || fallbackArtifactType;
      if (type) artifact.type = type;
    }
    if (artifact.content === undefined) {
      artifact.content = artifact.artifact_content ?? obj.content ?? obj.artifact_content ?? {};
    }
    obj.artifact = artifact;
  }

  return obj;
}
