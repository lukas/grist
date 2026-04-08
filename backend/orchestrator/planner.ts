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

CRITICAL RULES FOR EMPTY/NEW REPOS:
- When the repo is empty or has very few files, use a SINGLE implementation task.
- Multiple parallel implementation tasks on an empty repo will all start by exploring and then create conflicting files.
- Only split into multiple tasks when there are EXISTING files to parallelize against.

PARALLELISM RULES for repos with existing code:
- PARALLEL analysis tasks on separate parts of a large codebase (>20 files)
- SEQUENTIAL: analysis → implementation (depends_on) when you need to understand before changing
- PARALLEL implementation tasks ONLY when tasks modify SEPARATE, INDEPENDENT files that don't import each other
- SEQUENTIAL (depends_on) when one task creates a module that another imports

When to use 1 task:
- Empty or small repo (< 10 files) — always prefer a single implementation task
- Single focused deliverable
- Trivial changes (rename, fix typo, add comment)
- Project where components import each other (game logic + display = 1 task, not 2)

When to use 2+ SEQUENTIAL tasks:
- "Analyze then fix" → analysis depends_on:[], implementation depends_on:[0]
- Multi-phase work where phase 2 reads phase 1's output

When to use 2+ PARALLEL tasks:
- Large repo with truly independent changes to separate files/modules
- Goal explicitly mentions multiple independent deliverables with no shared imports

Respond ONLY with JSON:
{
  "reasoning": "Why this task structure — justify parallelism or lack thereof",
  "tasks": [
    {
      "role": "short_name",
      "goal": "specific goal",
      "type": "analysis" | "implementation",
      "scope": {"area": "optional"},
      "max_steps": 20,
      "depends_on": []
    }
  ]
}
depends_on is 0-indexed into your tasks array. Tasks without depends_on run in parallel.`;

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
  if (isEmpty || fileCount <= 30) {
    return {
      reasoning: `${isEmpty ? "Empty" : "Small"} repo — single implementation task.`,
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

  // On empty or small repos, consolidate parallel impl tasks into one.
  // Multiple parallel impl tasks on an empty repo just duplicate exploration and create conflicts.
  if (isEmpty || fileCount < 10) {
    const implTasks = tasks.filter((t) => t.type === "implementation" && (!t.depends_on || t.depends_on.length === 0));
    if (implTasks.length > 1) {
      const mergedGoal = implTasks.map((t) => t.goal).join("; ");
      const otherTasks = tasks.filter((t) => t.type !== "implementation" || (t.depends_on && t.depends_on.length > 0));
      return {
        reasoning: `${plan.reasoning} [Merged ${implTasks.length} parallel impl tasks into 1 — repo is ${isEmpty ? "empty" : "small"}]`,
        tasks: [
          ...otherTasks,
          {
            role: "developer",
            goal: mergedGoal,
            type: "implementation",
            max_steps: 30,
            depends_on: otherTasks.length > 0 ? [0] : undefined,
          },
        ],
      };
    }
  }

  // Cap at 6 parallel tasks to avoid resource exhaustion
  if (tasks.length > 6) {
    return {
      reasoning: `${plan.reasoning} [Capped from ${tasks.length} to 6 tasks]`,
      tasks: tasks.slice(0, 6),
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
