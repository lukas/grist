import { getJob } from "../db/jobRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { addJobTokenUsage } from "../db/jobRepo.js";
import { updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { VerifierOutputSchema } from "../types/taskState.js";
import { extractJsonObject } from "../providers/jsonExtract.js";
import { getWorktreeDiff } from "../workspace/worktreeManager.js";
import { toolRunTests } from "../tools/executionTools.js";
import type { ToolContext } from "../tools/toolTypes.js";

export async function runVerifierPass(
  task: TaskRow,
  opts: { testCommand?: string },
  toolCtx: ToolContext,
  signal?: AbortSignal
): Promise<void> {
  const job = getJob(task.job_id);
  if (!job || !task.worktree_path) {
    updateTask(task.id, { status: "failed", blocker: "missing job or worktree" });
    return;
  }
  const diff = getWorktreeDiff(job.repo_path, task.worktree_path);
  const testRes = await toolRunTests(
    toolCtx,
    { command: opts.testCommand, cwd: task.worktree_path },
    signal
  );

  const settings = loadAppSettings();
  const provider = createProvider(task.assigned_model_provider, settings);
  const prompt = `Verifier worker. Goal: ${job.user_goal}
Diff ok: ${diff.ok}
Diff preview: ${(diff.diff || "").slice(0, 40_000)}
Test tool result: ${JSON.stringify(testRes).slice(0, 20_000)}

Return JSON:
- passed (boolean)
- checks ([{name, status: passed|failed|skipped, details}])
- tests_run (string[])
- failures (string[])
- failing_logs_summary (string)
- likely_root_cause (string)
- summary (string)
- confidence (0-1)
- recommended_next_action (string)`;

  const resp = await provider.generateText({
    systemPrompt: "Output only JSON for verifier schema.",
    userPrompt: prompt,
    maxTokens: 2048,
    temperature: 0,
  });
  const parsed = VerifierOutputSchema.parse(extractJsonObject(resp.text));
  insertArtifact({
    job_id: task.job_id,
    task_id: task.id,
    type: "verification_result",
    content_json: JSON.stringify({ ...parsed, rawTest: testRes, diffOk: diff.ok }),
    confidence: parsed.confidence,
  });
  addJobTokenUsage(task.job_id, resp.tokensIn + resp.tokensOut, resp.estimatedCost);
  updateTask(task.id, {
    status: "done",
    current_action: "verified",
    next_action: "",
    confidence: parsed.confidence,
  });
  insertEvent({
    job_id: task.job_id,
    task_id: task.id,
    level: parsed.passed ? "info" : "warn",
    type: "verifier_done",
    message: parsed.summary,
    data_json: JSON.stringify({ passed: parsed.passed }),
  });
}
