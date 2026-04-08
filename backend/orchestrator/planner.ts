import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { insertTask, updateTask } from "../db/taskRepo.js";
import { updateJob } from "../db/jobRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import type { JobRow } from "../db/jobRepo.js";
import type { ModelProviderName, TaskKind } from "../types/models.js";
import { scratchpadPath as scratchPath } from "../workspace/pathUtils.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";

const ANALYSIS_TOOLS = ALL_TOOL_NAMES.filter(
  (n) => !["write_file", "apply_patch", "create_worktree", "remove_worktree"].includes(n)
);

const IMPLEMENTATION_TOOLS = [...ALL_TOOL_NAMES];

export interface PlanResult {
  taskIds: number[];
}

interface TaskSpec {
  kind: TaskKind;
  role: string;
  goal: string;
  scope: Record<string, unknown>;
  deps: number[];
  allowed: string[];
  write_mode: "none" | "worktree";
  workspace_mode: "shared_read_only" | "isolated_worktree";
  artifact_type: string;
  max_steps: number;
  max_tokens: number;
  priority: number;
  provider: ModelProviderName;
}

function quickRepoScan(repoPath: string): { files: string[]; isEmpty: boolean } {
  const max = 200;
  const files: string[] = [];
  const walk = (dir: string) => {
    if (files.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === ".git" || e === "node_modules" || e === ".grist" || e === ".venv" || e === "__pycache__") continue;
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else {
        files.push(relative(repoPath, full));
      }
      if (files.length >= max) return;
    }
  };
  if (existsSync(repoPath)) walk(repoPath);
  return { files, isEmpty: files.length === 0 };
}

interface LLMPlan {
  reasoning: string;
  tasks: {
    role: string;
    goal: string;
    type: "analysis" | "implementation";
    scope?: Record<string, unknown>;
    max_steps?: number;
    depends_on?: number[];
  }[];
}

function buildPlannerPrompt(goal: string, operatorNotes: string, files: string[], isEmpty: boolean): { system: string; user: string } {
  const system = `You are a planning agent for Grist, a coding agent supervisor.
Given a user's goal and the current repo state, decide what tasks to create.

PRIMARY OBJECTIVE: Minimize wall-clock time while producing working code.

Task types:
- "analysis": read-only (list_files, read_file, grep_code, read_git_history). For investigating existing code.
- "implementation": read+write (write_file, apply_patch, run_command_safe, etc). For creating/modifying code.

PARALLELISM STRATEGY — always look for parallelism opportunities:

For EMPTY repos (greenfield):
- If the goal describes multiple components/modules (e.g. "chess engine + AI + display"), split into 2-4 PARALLEL implementation tasks, each writing to separate files/directories.
- ALWAYS create a brief "architect" task first (depends_on:[]) with max_steps:5 that defines shared interfaces/types in a shared file. Then fan out parallel implementation tasks (depends_on:[0]) that each build one module.
- Example: goal "build chess game" → architect (defines interfaces), then parallel: rules_engine, ai_engine, display_cli, main_game_loop.
- Each task MUST specify scope.files listing which files it owns to avoid write conflicts.
- Only use 1 task if the goal is genuinely trivial (< 50 lines of code expected).

For EXISTING repos:
- PARALLEL analysis tasks on separate parts of a large codebase (>20 files)
- PARALLEL implementation tasks ONLY when they write to entirely different directories/files
- SEQUENTIAL (depends_on) when one task needs output of another
- Small repo (<10 files) with a focused goal → 1-2 tasks

Respond ONLY with JSON:
{
  "reasoning": "Why this task structure — justify parallelism or lack thereof",
  "tasks": [
    {
      "role": "short_name",
      "goal": "specific goal including which files to create/modify",
      "type": "analysis" | "implementation",
      "scope": {"files": ["specific/files.js"], "area": "optional"},
      "max_steps": 20,
      "depends_on": []
    }
  ]
}
depends_on is 0-indexed into your tasks array. Tasks without depends_on run in parallel.
IMPORTANT: For multi-component projects, prefer 3-5 parallel tasks over 1 monolithic task. Each task should specify which files it owns in scope.files to avoid write conflicts.`;

  const filesSummary = isEmpty
    ? "The repository is EMPTY (no files). This is a brand new project."
    : `Repository contains ${files.length}${files.length >= 200 ? "+" : ""} files:\n${files.join("\n")}`;

  const user = `Goal: ${goal}
${operatorNotes ? `Operator notes: ${operatorNotes}\n` : ""}
${filesSummary}`;

  return { system, user };
}

function parseLLMPlan(text: string): LLMPlan | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    if (obj.reasoning && obj.reason && !obj.reasoning) {
      obj.reasoning = obj.reason;
    }
    return obj as unknown as LLMPlan;
  } catch {
    return null;
  }
}

function fallbackPlan(goal: string, isEmpty: boolean, fileCount: number): LLMPlan {
  if (isEmpty) {
    return {
      reasoning: "Empty repo — architect defines structure, then implementer builds it.",
      tasks: [
        { role: "architect", goal: `Define module structure and shared interfaces for: ${goal}. Create a brief ARCHITECTURE.md and any shared type/config files.`, type: "implementation", max_steps: 5, scope: { files: ["ARCHITECTURE.md", "types.js"] } },
        { role: "implementer", goal: `Build the full project: ${goal}`, type: "implementation", max_steps: 40, depends_on: [0] },
      ],
    };
  }
  if (fileCount <= 30) {
    return {
      reasoning: `Small repo (${fileCount} files) — single implementation task.`,
      tasks: [{
        role: "developer",
        goal,
        type: "implementation",
        max_steps: 30,
      }],
    };
  }
  return {
    reasoning: `Larger repo (${fileCount} files) — analyze first, then implement.`,
    tasks: [
      { role: "codebase_scan", goal: `Analyze existing code for: ${goal}`, type: "analysis", max_steps: 20 },
      { role: "implementer", goal: `Implement changes for: ${goal}`, type: "implementation", max_steps: 30, depends_on: [0] },
    ],
  };
}

function validateParallelism(plan: LLMPlan, isEmpty: boolean, fileCount: number): LLMPlan {
  const tasks = plan.tasks;
  if (tasks.length <= 1) return plan;

  // Cap at 6 tasks max to avoid oversubscription
  if (tasks.length > 6) {
    return {
      reasoning: `${plan.reasoning} [Capped from ${tasks.length} to 6 tasks]`,
      tasks: tasks.slice(0, 6),
    };
  }

  // If parallel implementation tasks specify different scope.files, allow them
  const parallelImpl = tasks.filter((t) => t.type === "implementation" && (!t.depends_on || t.depends_on.length === 0));
  if (parallelImpl.length > 1) {
    const allHaveScope = parallelImpl.every((t) => {
      const scope = t.scope as Record<string, unknown> | undefined;
      return scope?.files && Array.isArray(scope.files) && (scope.files as string[]).length > 0;
    });
    if (allHaveScope) {
      return plan;
    }
    // No scopes — merge to avoid write conflicts (safety)
    const implGoal = parallelImpl.map((t) => t.goal).join("; ");
    const otherTasks = tasks.filter((t) => !(t.type === "implementation" && (!t.depends_on || t.depends_on.length === 0)));
    const mergedImpl = {
      role: "implementer",
      goal: implGoal,
      type: "implementation" as const,
      max_steps: Math.max(...parallelImpl.map((t) => t.max_steps || 20), 30),
      depends_on: otherTasks.length > 0 ? otherTasks.map((_: unknown, i: number) => i) : undefined as number[] | undefined,
    };
    return {
      reasoning: `${plan.reasoning} [Merged ${parallelImpl.length} parallel impl tasks — no scope.files specified]`,
      tasks: [...otherTasks, mergedImpl],
    };
  }

  return plan;
}

export async function runPlanner(job: JobRow, appWorkspaceRoot: string): Promise<PlanResult> {
  const defaultP = job.default_model_provider as ModelProviderName;
  const plannerP = (job.planner_model_provider as ModelProviderName) || defaultP;

  updateJob(job.id, { status: "planning" });
  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_start",
    message: "Planner scanning repo and deciding tasks",
    data_json: JSON.stringify({ goal: job.user_goal, provider: plannerP }),
  });

  const { files, isEmpty } = quickRepoScan(job.repo_path);
  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_repo_scan",
    message: `Repo scan: ${files.length} files${isEmpty ? " (empty repo)" : ""}`,
    data_json: JSON.stringify({ fileCount: files.length, isEmpty, sample: files.slice(0, 30) }),
  });

  let plan: LLMPlan;
  const { system, user } = buildPlannerPrompt(job.user_goal, job.operator_notes, files, isEmpty);

  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_prompt",
    message: "Sending goal + repo context to LLM planner",
    data_json: JSON.stringify({ system, user }),
  });

  try {
    const settings = loadAppSettings();
    const provider = createProvider(plannerP, settings);
    const resp = await provider.generateStructured({
      systemPrompt: system,
      userPrompt: user,
      maxTokens: 2048,
      temperature: 0.3,
    });

    insertEvent({
      job_id: job.id,
      task_id: null,
      level: "info",
      type: "planner_response",
      message: "LLM planner responded",
      data_json: JSON.stringify({
        raw: resp.text.slice(0, 4000),
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        cost: resp.estimatedCost,
      }),
    });

    const parsed = parseLLMPlan(resp.text);
    if (parsed && parsed.tasks?.length > 0) {
      plan = parsed;
    } else {
      insertEvent({
        job_id: job.id,
        task_id: null,
        level: "warn",
        type: "planner_parse_fallback",
        message: "Could not parse LLM plan, using fallback",
        data_json: JSON.stringify({ raw: resp.text.slice(0, 2000) }),
      });
      plan = fallbackPlan(job.user_goal, isEmpty, files.length);
    }
  } catch (e) {
    insertEvent({
      job_id: job.id,
      task_id: null,
      level: "warn",
      type: "planner_error_fallback",
      message: `LLM planner failed (${String(e)}), using fallback`,
    });
    plan = fallbackPlan(job.user_goal, isEmpty, files.length);
  }

  // Validate: enforce sensible parallelism
  const originalCount = plan.tasks.length;
  plan = validateParallelism(plan, isEmpty, files.length);
  if (plan.tasks.length !== originalCount) {
    insertEvent({
      job_id: job.id,
      task_id: null,
      level: "info",
      type: "planner_adjusted",
      message: `Adjusted plan from ${originalCount} to ${plan.tasks.length} tasks (parallelism check)`,
      data_json: JSON.stringify({ originalCount, newCount: plan.tasks.length }),
    });
  }

  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_reasoning",
    message: plan.reasoning,
    data_json: JSON.stringify({
      reasoning: plan.reasoning,
      taskCount: plan.tasks.length,
      tasks: plan.tasks.map((t) => ({ role: t.role, type: t.type, goal: t.goal })),
    }),
  });

  const taskIds: number[] = [];
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const isImpl = t.type === "implementation";
    const deps = (t.depends_on || []).map((idx) => taskIds[idx]).filter((id) => id != null);
    const hasDeps = deps.length > 0;

    const id = insertTask({
      job_id: job.id,
      parent_task_id: null,
      kind: isImpl ? "patch_writer" : "analysis",
      role: t.role,
      goal: t.goal,
      scope_json: JSON.stringify(t.scope || {}),
      status: hasDeps ? "blocked" : "queued",
      priority: plan.tasks.length - i,
      assigned_model_provider: defaultP,
      write_mode: isImpl ? "worktree" : "none",
      workspace_repo_mode: isImpl ? "isolated_worktree" : "shared_read_only",
      scratchpad_path: "",
      worktree_path: null,
      max_steps: t.max_steps || (isImpl ? 50 : 30),
      max_tokens: isImpl ? 200000 : 100000,
      current_action: hasDeps ? "blocked" : "queued",
      next_action: hasDeps ? "wait_deps" : "start",
      blocker: hasDeps ? "waiting for dependencies" : "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify(deps),
      allowed_tools_json: JSON.stringify(isImpl ? IMPLEMENTATION_TOOLS : ANALYSIS_TOOLS),
      artifact_type: isImpl ? "candidate_patch" : "findings_report",
    });
    taskIds.push(id);
  }

  for (const tid of taskIds) {
    updateTask(tid, { scratchpad_path: scratchPath(appWorkspaceRoot, job.id, tid) });
  }

  insertEvent({
    job_id: job.id,
    task_id: null,
    level: "info",
    type: "planner_done",
    message: `Created ${taskIds.length} tasks: ${plan.tasks.map((t) => t.role).join(", ")}`,
    data_json: JSON.stringify({ taskIds, reasoning: plan.reasoning }),
  });

  updateJob(job.id, { status: "running" });
  return { taskIds };
}
