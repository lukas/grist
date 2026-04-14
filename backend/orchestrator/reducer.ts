import { getJob, addJobTokenUsage } from "../db/jobRepo.js";
import { listArtifactsForJob, insertArtifact } from "../db/artifactRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { ReducerOutputSchema } from "../types/taskState.js";
import { extractJsonObject } from "../providers/jsonExtract.js";
import { tryParseModelJson } from "./workerDecisionUtils.js";

const REDUCER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "confirmed_facts",
    "top_hypotheses",
    "contradictions",
    "recommended_next_tasks",
    "open_questions",
    "handoff_notes",
    "overall_confidence",
    "summary_text",
    "final_summary",
    "recommendation",
  ],
  properties: {
    confirmed_facts: { type: "array" },
    top_hypotheses: { type: "array" },
    contradictions: { type: "array" },
    recommended_next_tasks: { type: "array" },
    open_questions: { type: "array" },
    handoff_notes: { type: "array" },
    overall_confidence: { type: "number" },
    summary_text: { type: "string" },
    final_summary: { type: "string" },
    recommendation: { type: "string" },
  },
} as const;

export async function runReducerPass(task: TaskRow): Promise<void> {
  const job = getJob(task.job_id);
  if (!job) return;
  const settings = loadAppSettings();
  const provider = createProvider(task.assigned_model_provider, settings);
  const artifacts = listArtifactsForJob(task.job_id) as { type: string; content_json: string }[];
  const prompt = `You are the summarizer worker. Job goal: ${job.user_goal}
Operator notes: ${job.operator_notes || "(none)"}

Worker artifacts:
${JSON.stringify(artifacts.map((a) => ({ type: a.type, content: JSON.parse(a.content_json) })), null, 2).slice(0, 120_000)}

Return JSON with keys:
- confirmed_facts (string[])
- top_hypotheses (string[])
- contradictions (string[])
- recommended_next_tasks (string[])
- open_questions (string[])
- handoff_notes (string[])
- overall_confidence (number 0-1)
- summary_text (string)
- final_summary (string)
- recommendation one of: no_more_work | spawn_patch | verification_required | replan_required`;

  const sys = "You output only valid JSON for the summarizer schema.";
  const resp = await provider.generateStructured({
    systemPrompt: sys,
    userPrompt: prompt,
    jsonSchema: REDUCER_JSON_SCHEMA,
    maxTokens: 4096,
    temperature: 0.1,
  });
  let parsed;
  try {
    parsed = ReducerOutputSchema.parse(resp.parsedJson ?? tryParseModelJson(resp.text) ?? extractJsonObject(resp.text));
  } catch (parseError) {
    try {
      const repair = await provider.generateText({
        systemPrompt: `${sys}\nRepair invalid summarizer JSON into the required schema.`,
        userPrompt: `Repair this invalid summarizer output into valid JSON only.

Schema:
${JSON.stringify(REDUCER_JSON_SCHEMA, null, 2)}

Validation / parse error:
${String(parseError)}

Invalid output:
${resp.text.slice(0, 12000)}`,
        jsonSchema: REDUCER_JSON_SCHEMA,
        maxTokens: 4096,
        temperature: 0,
      });
      parsed = ReducerOutputSchema.parse(tryParseModelJson(repair.text) ?? extractJsonObject(repair.text));
      addJobTokenUsage(task.job_id, repair.tokensIn + repair.tokensOut, repair.estimatedCost);
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "warn",
        type: "reducer_repaired",
        message: "Recovered invalid summarizer output via repair pass",
      });
    } catch {
      const fallback = ReducerOutputSchema.parse({
        confirmed_facts: artifacts.map((artifact) => artifact.type),
        top_hypotheses: [],
        contradictions: [],
        recommended_next_tasks: [],
        open_questions: [],
        handoff_notes: ["Summarizer output was invalid; using fallback summary built from worker artifacts."],
        overall_confidence: 0.3,
        summary_text: "Fallback summary generated from completed worker artifacts.",
        final_summary: `Fallback summary: available artifacts were ${artifacts.map((artifact) => artifact.type).join(", ") || "none"}.`,
        recommendation: "no_more_work",
      });
      parsed = fallback;
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level: "warn",
        type: "reducer_fallback",
        message: "Summarizer output was invalid; generated fallback final summary",
      });
    }
  }
  insertArtifact({
    job_id: task.job_id,
    task_id: task.id,
    type: "final_summary",
    content_json: JSON.stringify(parsed),
    confidence: parsed.overall_confidence,
  });
  addJobTokenUsage(task.job_id, resp.tokensIn + resp.tokensOut, resp.estimatedCost);
  updateTask(task.id, {
    status: "done",
    current_action: "reducer_complete",
    next_action: "",
    confidence: parsed.overall_confidence,
    findings_json: JSON.stringify(parsed.confirmed_facts),
  });
  insertEvent({
    job_id: task.job_id,
    task_id: task.id,
    level: "info",
    type: "reducer_done",
    message: (parsed.final_summary || parsed.summary_text).slice(0, 500),
    data_json: JSON.stringify({ recommendation: parsed.recommendation }),
  });
}
