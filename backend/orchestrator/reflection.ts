import type { ModelProvider } from "../types/models.js";
import type { ToolEmit } from "../tools/toolTypes.js";
import {
  readHomeSummary,
  writeHomeSummary,
  readRepoSummary,
  writeRepoSummary,
  writeHomeMemoryFile,
  writeRepoMemoryFile,
  REPO_SUMMARY_MAX_CHARS,
  HOME_SUMMARY_MAX_CHARS,
} from "../memory/memoryManager.js";
import { extractJsonObject } from "../providers/jsonExtract.js";
import { tryParseModelJson } from "./workerDecisionUtils.js";

const REFLECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["project_memory", "global_memory", "update_project_summary", "update_global_summary"],
  properties: {
    project_memory: { type: "string" },
    global_memory: { type: "string" },
    update_project_summary: { anyOf: [{ type: "string" }, { type: "null" }] },
    update_global_summary: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

export interface TaskOutcome {
  stepsUsed: number;
  maxSteps: number;
  tokensUsed: number;
  estimatedCost: number;
  wallClockMs: number;
  filesExamined: string[];
  filesModified: string[];
  compactionsRun: number;
  budgetExtensions: number;
  errorCount: number;
  gitDiffStat: string;
}

interface ReflectionInput {
  taskId: number;
  jobId: number;
  repoPath: string;
  taskGoal: string;
  taskRole: string;
  history: { role: string; content: string }[];
  reasoning: string;
  provider: ModelProvider;
  emit: ToolEmit;
  outcome?: TaskOutcome;
}

export async function runReflection(input: ReflectionInput): Promise<void> {
  const { taskId, repoPath, taskGoal, taskRole, history, reasoning, provider, emit, outcome } = input;

  const recentHistory = history
    .slice(-12)
    .map((h) => `[${h.role}] ${h.content.slice(0, 250)}`)
    .join("\n");

  const currentRepoSummary = readRepoSummary(repoPath);
  const currentHomeSummary = readHomeSummary();

  const outcomeBlock = outcome
    ? `\nMetrics:
- Steps: ${outcome.stepsUsed}/${outcome.maxSteps}
- Tokens: ${outcome.tokensUsed} (~$${outcome.estimatedCost.toFixed(4)})
- Wall clock: ${Math.round(outcome.wallClockMs / 1000)}s
- Files examined: ${outcome.filesExamined.length} (${outcome.filesExamined.slice(0, 5).join(", ")}${outcome.filesExamined.length > 5 ? "..." : ""})
- Files modified: ${outcome.filesModified.length} (${outcome.filesModified.join(", ") || "none"})
- Errors: ${outcome.errorCount}, Compactions: ${outcome.compactionsRun}, Budget extensions: ${outcome.budgetExtensions}
- Git diff: ${outcome.gitDiffStat}`
    : "";

  const prompt = `A coding task just completed. Write a memory note capturing what was done and learned.

Task: ${taskGoal}
Role: ${taskRole}
Outcome: ${reasoning}
${outcomeBlock}

Recent activity (last 12 entries):
${recentHistory}

Current project summary (${currentRepoSummary.length} chars, max ${REPO_SUMMARY_MAX_CHARS}):
${currentRepoSummary.slice(0, 1200)}

Current global summary (${currentHomeSummary.length} chars, max ${HOME_SUMMARY_MAX_CHARS}):
${currentHomeSummary.slice(0, 800)}

Respond with JSON:
{
  "project_memory": "REQUIRED. 2-5 sentences: what was done, what files were touched, any patterns/conventions/gotchas discovered, architecture decisions made. This is a project-local note.",
  "global_memory": "Optional. 1-3 sentences about general techniques or pitfalls useful across any project. Empty string if nothing general was learned.",
  "update_project_summary": "Updated project summary.md (max ${REPO_SUMMARY_MAX_CHARS} chars) incorporating this task's work. Must be a FULL rewrite. null if no update needed.",
  "update_global_summary": null
}

RULES:
- project_memory is MANDATORY — every task produces something worth noting. Include: what was accomplished, key files modified, any gotchas or decisions.
- global_memory is optional — only if a broadly useful technique or pitfall was encountered.
- Only update summaries when the project's high-level description should change (new features, architecture shifts).`;

  let resp;
  try {
    resp = await provider.generateStructured({
      systemPrompt: "You are a memory-management assistant. Write concise notes capturing what a task accomplished and learned. Always produce a project_memory note. Only JSON output.",
      userPrompt: prompt,
      jsonSchema: REFLECTION_JSON_SCHEMA,
      maxTokens: 2048,
      temperature: 0.2,
    });
  } catch (e) {
    emit("warn", "reflection_error", `Reflection LLM call failed: ${e}`);
    // Even if LLM fails, write a minimal mechanical note
    const fallback = `Task "${taskGoal}" completed. Role: ${taskRole}. Outcome: ${reasoning.slice(0, 500)}`;
    writeRepoMemoryFile(repoPath, taskRole || `task-${taskId}`, fallback);
    emit("info", "reflection_done", "Reflection: wrote fallback project note (LLM failed)");
    return;
  }

  let result: {
    project_memory?: string;
    global_memory?: string;
    update_project_summary?: string | null;
    update_global_summary?: string | null;
  };

  try {
    const parsed = resp.parsedJson ?? tryParseModelJson(resp.text) ?? extractJsonObject(resp.text);
    result = parsed as typeof result;
  } catch (parseError) {
    try {
      const repair = await provider.generateText({
        systemPrompt: "You are a memory-management assistant. Repair invalid reflection output into one valid JSON object only.",
        userPrompt: `Repair this invalid reflection output into valid JSON matching the required schema.

Schema:
${JSON.stringify(REFLECTION_JSON_SCHEMA, null, 2)}

Validation / parse error:
${String(parseError)}

Invalid output:
${resp.text.slice(0, 8000)}`,
        jsonSchema: REFLECTION_JSON_SCHEMA,
        maxTokens: 2048,
        temperature: 0,
      });
      const repaired = tryParseModelJson(repair.text) ?? extractJsonObject(repair.text);
      result = repaired as typeof result;
      emit("warn", "reflection_repaired", "Reflection output repaired after invalid JSON");
    } catch {
      // Parse failed — write a mechanical note
      const fallback = `Task "${taskGoal}" completed. Role: ${taskRole}. Outcome: ${reasoning.slice(0, 500)}`;
      writeRepoMemoryFile(repoPath, taskRole || `task-${taskId}`, fallback);
      emit("info", "reflection_done", "Reflection: wrote fallback project note (parse failed)");
      return;
    }
  }

  const actions: string[] = [];

  // Project memory is mandatory — use fallback if LLM returned empty
  const projNote = result.project_memory?.trim()
    || `Task "${taskGoal}" completed by ${taskRole}. ${reasoning.slice(0, 300)}`;
  writeRepoMemoryFile(repoPath, taskRole || `task-${taskId}`, projNote);
  actions.push("project note");

  if (result.global_memory?.trim()) {
    writeHomeMemoryFile(taskRole || `task-${taskId}`, result.global_memory);
    actions.push("global note");
  }

  if (typeof result.update_project_summary === "string" && result.update_project_summary.trim()) {
    writeRepoSummary(repoPath, result.update_project_summary);
    actions.push("project summary");
  }

  if (typeof result.update_global_summary === "string" && result.update_global_summary.trim()) {
    writeHomeSummary(result.update_global_summary);
    actions.push("global summary");
  }

  emit("info", "reflection_done", `Reflection updated: ${actions.join(", ")}`);
}
