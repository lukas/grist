import { getJob, addJobTokenUsage } from "../db/jobRepo.js";
import { listArtifactsForJob, insertArtifact } from "../db/artifactRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { ReducerOutputSchema } from "../types/taskState.js";
import { extractJsonObject } from "../providers/jsonExtract.js";

export async function runReducerPass(task: TaskRow): Promise<void> {
  const job = getJob(task.job_id);
  if (!job) return;
  const settings = loadAppSettings();
  const provider = createProvider(task.assigned_model_provider, settings);
  const artifacts = listArtifactsForJob(task.job_id) as { type: string; content_json: string }[];
  const findings = artifacts.filter((a) => a.type === "findings_report").map((a) => JSON.parse(a.content_json));

  const prompt = `You are the reducer. Job goal: ${job.user_goal}
Operator notes: ${job.operator_notes || "(none)"}

Findings artifacts:
${JSON.stringify(findings, null, 2).slice(0, 120_000)}

Return JSON with keys: confirmed_facts (string[]), top_hypotheses (string[]), contradictions (string[]), recommended_next_tasks (string[]), overall_confidence (number 0-1), summary_text (string), recommendation one of: no_more_work | spawn_patch | verification_required | replan_required`;

  const sys = "You output only valid JSON for the reducer schema.";
  const resp = await provider.generateText({
    systemPrompt: sys,
    userPrompt: prompt,
    maxTokens: 4096,
    temperature: 0.1,
  });
  const parsed = ReducerOutputSchema.parse(extractJsonObject(resp.text));
  insertArtifact({
    job_id: task.job_id,
    task_id: task.id,
    type: "reducer_summary",
    content_json: JSON.stringify(parsed),
    confidence: parsed.overall_confidence,
  });
  addJobTokenUsage(task.job_id, resp.tokensIn + resp.tokensOut, resp.estimatedCost);
  updateTask(task.id, {
    status: "done",
    current_action: "reducer_complete",
    next_action: "",
    confidence: parsed.overall_confidence,
    findings_json: JSON.stringify(parsed.top_hypotheses),
  });
  insertEvent({
    job_id: task.job_id,
    task_id: task.id,
    level: "info",
    type: "reducer_done",
    message: parsed.summary_text.slice(0, 500),
    data_json: JSON.stringify({ recommendation: parsed.recommendation }),
  });
}
