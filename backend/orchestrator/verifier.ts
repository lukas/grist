import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getJob } from "../db/jobRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { addJobTokenUsage } from "../db/jobRepo.js";
import { getTask, updateTask } from "../db/taskRepo.js";
import type { TaskRow } from "../db/taskRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { VerifierOutputSchema } from "../types/taskState.js";
import { getWorktreeDiff } from "../workspace/worktreeManager.js";
import { toolRunCommandSafe } from "../tools/executionTools.js";
import type { ToolContext, ToolResult } from "../tools/toolTypes.js";
import { tryParseModelJson } from "./workerDecisionUtils.js";

const VERIFIER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "passed",
    "checks",
    "tests_run",
    "failures",
    "failing_logs_summary",
    "likely_root_cause",
    "summary",
    "confidence",
    "recommended_next_action",
  ],
  properties: {
    passed: { type: "boolean" },
    checks: { type: "array" },
    tests_run: { type: "array" },
    failures: { type: "array" },
    failing_logs_summary: { type: "string" },
    likely_root_cause: { type: "string" },
    summary: { type: "string" },
    confidence: { type: "number" },
    recommended_next_action: { type: "string" },
  },
} as const;

interface VerificationCommand {
  name: string;
  command: string;
  timeoutMs: number;
  allowTimeoutSuccess?: boolean;
}

interface VerificationOutcome {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  details: string;
  result: ToolResult;
}

function detectPackageManager(worktreePath: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageManagerCommand(worktreePath: string, script: "test" | "build" | "start"): string {
  switch (detectPackageManager(worktreePath)) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "npm":
    default:
      return script === "build" ? "npm run build" : `npm ${script}`;
  }
}

function readPackageScripts(worktreePath: string): Record<string, string> {
  const packageJsonPath = join(worktreePath, "package.json");
  if (!existsSync(packageJsonPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function chooseVerificationCommands(worktreePath: string, explicitCommand?: string): VerificationCommand[] {
  if (explicitCommand?.trim()) {
    return [{ name: "explicit_verification", command: explicitCommand.trim(), timeoutMs: 120_000 }];
  }
  const scripts = readPackageScripts(worktreePath);
  const commands: VerificationCommand[] = [];
  if (scripts.test) {
    commands.push({ name: "test_execution", command: packageManagerCommand(worktreePath, "test"), timeoutMs: 120_000 });
  }
  if (scripts.build) {
    commands.push({ name: "build_execution", command: packageManagerCommand(worktreePath, "build"), timeoutMs: 120_000 });
  }
  if (scripts.start && !scripts.test) {
    commands.push({
      name: "startup_smoke",
      command: packageManagerCommand(worktreePath, "start"),
      timeoutMs: 15_000,
      allowTimeoutSuccess: true,
    });
  }
  if (commands.length === 0) {
    commands.push({ name: "default_test_execution", command: "npm test", timeoutMs: 120_000 });
  }
  return commands;
}

function extractCommandResult(result: ToolResult): { code: number | null; stdout: string; stderr: string } {
  if (!result.ok) return { code: null, stdout: "", stderr: result.error };
  const data = (result.data || {}) as { code?: number; stdout?: string; stderr?: string };
  return {
    code: typeof data.code === "number" ? data.code : null,
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    stderr: typeof data.stderr === "string" ? data.stderr : "",
  };
}

function isHealthyStartupTimeout(result: ToolResult): boolean {
  if (!result.ok) return false;
  const { code, stdout, stderr } = extractCommandResult(result);
  if (code !== 124) return false;
  if (!stdout.trim()) return false;
  return !/\b(error|exception|traceback|cannot find|missing script|not found)\b/i.test(`${stdout}\n${stderr}`);
}

function summarizeOutcome(command: VerificationCommand, result: ToolResult): VerificationOutcome {
  if (!result.ok) {
    return {
      name: command.name,
      command: command.command,
      status: "failed",
      details: result.error,
      result,
    };
  }
  const { code, stdout, stderr } = extractCommandResult(result);
  if (code === 0) {
    return {
      name: command.name,
      command: command.command,
      status: "passed",
      details: "Command exited successfully.",
      result,
    };
  }
  if (command.allowTimeoutSuccess && isHealthyStartupTimeout(result)) {
    return {
      name: command.name,
      command: command.command,
      status: "passed",
      details: "Interactive startup produced output and then hit the smoke-test timeout.",
      result,
    };
  }
  const combined = `${stdout}\n${stderr}`.trim();
  return {
    name: command.name,
    command: command.command,
    status: "failed",
    details: `Exit code ${code ?? "unknown"}${combined ? `: ${combined.slice(0, 500)}` : ""}`,
    result,
  };
}

function shouldOverrideVerifierFailure(parsed: ReturnType<typeof VerifierOutputSchema.parse>, outcomes: VerificationOutcome[]): boolean {
  const hardFailures = outcomes.filter((outcome) => outcome.status === "failed");
  const hasPositiveEvidence = outcomes.some((outcome) => outcome.status === "passed");
  const onlyMissingTestFailure = parsed.failures.every((failure) =>
    (/missing script/i.test(failure) && /test/i.test(failure))
      || /no test script/i.test(failure)
      || /test runner.*not found/i.test(failure)
      || /jest command not found/i.test(failure)
  );
  return !parsed.passed && hardFailures.length === 0 && hasPositiveEvidence && parsed.failures.length > 0 && onlyMissingTestFailure;
}

function applyVerificationPolicy(
  parsed: ReturnType<typeof VerifierOutputSchema.parse>,
  outcomes: VerificationOutcome[],
) {
  if (!shouldOverrideVerifierFailure(parsed, outcomes)) return parsed;
  return VerifierOutputSchema.parse({
    ...parsed,
    passed: true,
    failures: [],
    failing_logs_summary: "",
    likely_root_cause: parsed.likely_root_cause || "Available build/smoke checks passed; automated tests are missing.",
    summary: parsed.summary || "Available verification checks passed. Automated tests are still missing.",
    recommended_next_action: "Wrap up, but note that automated tests are still missing.",
  });
}

export async function runVerifierPass(
  task: TaskRow,
  opts: { testCommand?: string },
  toolCtx: ToolContext,
  signal?: AbortSignal
): Promise<void> {
  const job = getJob(task.job_id);
  const parent = task.parent_task_id ? getTask(task.parent_task_id) : undefined;
  const effectiveWorktree = task.worktree_path || (parent?.role === "implementer" ? parent.worktree_path : null);
  if (!job) {
    updateTask(task.id, { status: "failed", blocker: "missing job" });
    return;
  }
  if (!effectiveWorktree) {
    insertArtifact({
      job_id: task.job_id,
      task_id: task.id,
      type: "verification_result",
      content_json: JSON.stringify({
        passed: false,
        checks: [],
        tests_run: [],
        failures: ["Verifier skipped: no worktree available"],
        failing_logs_summary: "",
        likely_root_cause: "No implementer worktree attached to verifier",
        summary: "Skipped verifier because no worktree was available.",
        confidence: 0.2,
        recommended_next_action: "Inspect planner/orchestrator verifier attachment",
      }),
      confidence: 0.2,
    });
    updateTask(task.id, { status: "done", current_action: "verifier_skipped", blocker: "missing job or worktree" });
    insertEvent({
      job_id: task.job_id,
      task_id: task.id,
      level: "warn",
      type: "verifier_skipped",
      message: "Skipped verifier because no worktree was available",
    });
    return;
  }
  const diff = getWorktreeDiff(job.repo_path, effectiveWorktree);
  const validationCommands = chooseVerificationCommands(effectiveWorktree, opts.testCommand);
  const validationResults: VerificationOutcome[] = [];
  for (const validation of validationCommands) {
    const result = await toolRunCommandSafe(
      toolCtx,
      { command: validation.command, cwd: effectiveWorktree, timeoutMs: validation.timeoutMs },
      signal
    );
    const outcome = summarizeOutcome(validation, result);
    validationResults.push(outcome);
    if (outcome.status === "failed") break;
  }

  const settings = loadAppSettings();
  const provider = createProvider(task.assigned_model_provider, settings);
  const prompt = `Verifier worker. Goal: ${job.user_goal}
Diff ok: ${diff.ok}
Diff preview: ${(diff.diff || "").slice(0, 40_000)}
Validation commands run:
${validationCommands.map((command) => `- ${command.name}: ${command.command}`).join("\n")}

Validation outcomes:
${JSON.stringify(validationResults).slice(0, 20_000)}

Verification policy:
- Missing a test script is not, by itself, a failure if other available checks pass.
- Prefer the strongest available evidence among test, build, and startup smoke checks.
- If a startup smoke check times out after visible app output, treat that as successful startup evidence rather than a crash.
- Fail only when an available validation command actually fails, the app crashes on startup, or there is not enough evidence to trust the patch.

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

  const resp = await provider.generateStructured({
    systemPrompt: "Output only JSON for verifier schema.",
    userPrompt: prompt,
    jsonSchema: VERIFIER_JSON_SCHEMA,
    maxTokens: 2048,
    temperature: 0,
  });
  const parsed = applyVerificationPolicy(
    VerifierOutputSchema.parse(resp.parsedJson ?? tryParseModelJson(resp.text) ?? {}),
    validationResults,
  );
  insertArtifact({
    job_id: task.job_id,
    task_id: task.id,
    type: "verification_result",
    content_json: JSON.stringify({
      ...parsed,
      rawValidationResults: validationResults,
      validationPlan: validationCommands,
      diffOk: diff.ok,
    }),
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

export const __verifierInternals = {
  applyVerificationPolicy,
  chooseVerificationCommands,
  isHealthyStartupTimeout,
  summarizeOutcome,
};
