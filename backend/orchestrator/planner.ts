import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { insertTask, updateTask } from "../db/taskRepo.js";
import { updateJob } from "../db/jobRepo.js";
import { insertEvent } from "../db/eventRepo.js";
import { insertArtifact } from "../db/artifactRepo.js";
import type { JobRow } from "../db/jobRepo.js";
import type { ModelProviderName, TaskKind, WorkerRole } from "../types/models.js";
import { scratchpadPath as scratchPath } from "../workspace/pathUtils.js";
import { findRootTaskForJob } from "../db/rootTaskFacade.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";
import { createProvider } from "../providers/providerFactory.js";
import { extractJsonObject } from "../providers/jsonExtract.js";
import { loadAppSettings } from "../settings/appSettings.js";
import {
  ManagerPlanSchema,
  WorkerPacketSchema,
  type ManagerPlan,
  type PlannedWorkerTask,
  type WorkerPacket,
  expectedArtifactTypeForRole,
  normalizeWorkerPacket,
} from "../types/taskState.js";
import { normalizePlanContracts, validatePlanContracts } from "../services/contractService.js";
import { getPlannerContext } from "../services/memoryService.js";
import { startSpeculativeGroup } from "./bestOfN.js";

const ANALYSIS_TOOLS = ALL_TOOL_NAMES.filter(
  (n) => !["write_file", "apply_patch", "create_worktree", "remove_worktree"].includes(n)
);

const IMPLEMENTATION_TOOLS = ALL_TOOL_NAMES.filter(
  (n) => !["create_worktree", "remove_worktree"].includes(n)
);
const VERIFIER_TOOLS = ["run_tests", "run_command_safe", "read_scratchpad", "read_artifacts", "emit_progress_event"];

export interface PlanResult {
  taskIds: number[];
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

type FallbackTask = PlannedWorkerTask;

function packet(overrides: Partial<WorkerPacket>): WorkerPacket {
  return WorkerPacketSchema.parse(overrides);
}

function buildPlannerPrompt(goal: string, operatorNotes: string, files: string[], isEmpty: boolean, memoryContext = ""): { system: string; user: string } {
  const greenfieldGuidance = isEmpty
    ? `
Empty-repo guidance:
- For simple tasks, default to one implementer that bootstraps and delivers a runnable vertical slice.
- For tasks with clearly independent components (e.g., game logic, AI, CLI rendering), you CAN use multiple implementers IF you chain them with depends_on so the first creates the foundation and later ones build on it. The worktree from the first implementer is available to its dependents.
- Do NOT create parallel implementers in an empty repo — they cannot see each other's files. Use sequential (depends_on) chains instead.
- Do NOT split bootstrap/config/entrypoint work across multiple implementers — the first implementer should create the project structure.
- If you use a scout in a greenfield repo, keep it read-only and feed the implementer.`
    : "";
  const system = `You are the MANAGER agent for Grist. You are the single source of truth for a coding swarm.
Your job is to produce a compact, typed worker plan that:
- keeps one canonical plan
- only parallelizes independent work
- gives each worker exactly one job
- sends small GitHub-issue-style packets instead of freeform essays

Worker roles:
- scout: read-only repo reconnaissance, analogous implementations, test/command discovery
- implementer: writes code in an isolated worktree
- reviewer: read-only regression/style/API review
- verifier: runs tests/typechecks/commands against an implementer result
- summarizer: compresses worker artifacts into a final handoff

Rules:
- Use a manager-worker swarm, not a democracy. You own the accepted assumptions and final plan.
- Parallelize only independent work. Never fan out multiple implementers onto overlapping files.
- Treat context as scarce. Give workers only the files and constraints they need.
- Prefer scout -> implementer for existing repos when reconnaissance materially reduces risk.
- Prefer implementer -> verifier for code-writing work when a scoped test/check phase is useful.
- End the plan with exactly one summarizer unless the task is trivial enough that a final summary would be redundant.
- The scheduler dynamically allocates worker slots based on available CPU, memory, and urgency setting. The current max parallel workers is computed at runtime. You can plan more parallel tasks than the current limit — the scheduler will queue extras and launch them as slots free up.
${greenfieldGuidance}

Output ONLY valid JSON matching this shape:
{
  "reasoning": "why this manager plan is shaped this way",
  "accepted_assumptions": ["..."],
  "parallelism_notes": ["..."],
  "tasks": [
    {
      "role": "scout" | "implementer" | "verifier" | "reviewer" | "summarizer",
      "goal": "objective in GitHub issue style",
      "packet": {
        "files": ["exact/files.ts"],
        "area": "module or subsystem",
        "contract_json": {
          "inputs": ["findings_report"],
          "outputs": ["candidate_patch"],
          "file_ownership": ["exact/files.ts"],
          "acceptance_criteria": ["what done means"],
          "non_goals": ["what not to do"]
        },
        "acceptance_criteria": ["what done means"],
        "non_goals": ["what not to do"],
        "similar_patterns": ["paths or symbols to mimic"],
        "constraints": ["backward compatibility, APIs, style, etc"],
        "commands_allowed": ["npm run typecheck"],
        "success_criteria": ["artifact or verification expectations"]
      },
      "max_steps": 20,
      "depends_on": [0],
      "speculative_approaches": ["approach A description", "approach B description"]
    }
  ]
}

Requirements:
- depends_on is 0-indexed into the tasks array.
- Implementers SHOULD set packet.files whenever ownership is narrow or multiple implementers exist.
- If two implementers would touch the same files, merge them into one task.
- Scouts/reviewers should be read-only.
- Verifiers should depend on the implementer they validate.
- Summarizer should depend on all worker tasks it summarizes.
- If a task could benefit from exploring multiple approaches in parallel (e.g., two different algorithms, two different UI frameworks), you can add a "speculative_approaches" array to that task. Grist will spawn one implementation per approach, verify each, and pick the best. Use this sparingly — only when approaches are genuinely different and the cost of trying both is worth the quality gain.`;

  const filesSummary = isEmpty
    ? "The repository is EMPTY (no files). This is a brand new project."
    : `Repository contains ${files.length}${files.length >= 200 ? "+" : ""} files:\n${files.join("\n")}`;

  const user = `User goal: ${goal}
${operatorNotes ? `Operator notes: ${operatorNotes}\n` : ""}
${filesSummary}
${memoryContext ? `\nMemory context:\n${memoryContext}` : ""}`;

  return { system, user };
}

function parseLLMPlan(text: string): ManagerPlan | null {
  try {
    const obj = extractJsonObject(text) as Record<string, unknown>;
    if (obj.reasoning && obj.reason && !obj.reasoning) obj.reasoning = obj.reason;
    if (Array.isArray(obj.tasks) && !("parallelism_notes" in obj)) obj.parallelism_notes = [];
    if (Array.isArray(obj.tasks) && !("accepted_assumptions" in obj)) obj.accepted_assumptions = [];
    return ManagerPlanSchema.parse(obj);
  } catch {
    return null;
  }
}

function fallbackPlan(goal: string, isEmpty: boolean, fileCount: number): ManagerPlan {
  if (isEmpty) {
    return {
      reasoning: "Empty repo — prefer one writer that bootstraps the project and delivers a runnable slice end-to-end.",
      accepted_assumptions: [
        "Greenfield repo can be bootstrapped from the user goal alone.",
        "Sibling implementer worktrees do not share unmerged code automatically.",
      ],
      parallelism_notes: [
        "Use a single writer task for code changes; rely on parallel tool calls inside that task instead of multiple implementers.",
      ],
      tasks: [
        {
          role: "implementer",
          goal: `Bootstrap and implement the requested project end-to-end: ${goal}`,
          max_steps: 50,
          packet: packet({
            area: "greenfield bootstrap + full implementation",
            contract_json: {
              inputs: [],
              outputs: ["candidate_patch"],
              file_ownership: ["**/*"],
              acceptance_criteria: [
                "Create the runnable project scaffold first (manifest/config/entrypoint as needed)",
                "Implement the requested project end-to-end",
                "Run at least one focused validation command when possible",
              ],
              non_goals: ["Do not leave the repo split across partially complete writer branches"],
            },
            acceptance_criteria: [
              "Create the runnable project scaffold first (manifest/config/entrypoint as needed)",
              "Implement the requested project end-to-end",
              "Run at least one focused validation command when possible",
            ],
            non_goals: ["Do not leave the repo split across partially complete writer branches"],
            constraints: [
              "Keep shared bootstrap, integration, and final runnable state in this task unless the user explicitly decomposed the repo",
            ],
            success_criteria: [
              "Produce a candidate patch artifact",
              "Leave behind a coherent runnable implementation candidate",
            ],
          }),
          depends_on: [],
        },
      ],
    };
  }
  if (fileCount <= 30) {
    return {
      reasoning: `Small repo (${fileCount} files) — one scout for targeted reconnaissance, then one implementer.`,
      accepted_assumptions: ["The change is localized enough for one implementer after reconnaissance."],
      parallelism_notes: ["Sequential flow avoids merge thrash in a small repo."],
      tasks: [{
        role: "scout",
        goal: `Locate the relevant files, analogous patterns, and likely validation commands for: ${goal}`,
        max_steps: 12,
        packet: packet({
          contract_json: {
            inputs: [],
            outputs: ["findings_report"],
            file_ownership: [],
            acceptance_criteria: ["Return relevant files and analogous implementations"],
            non_goals: [],
          },
          acceptance_criteria: ["Return relevant files and analogous implementations"],
          success_criteria: ["Produce a findings_report artifact"],
        }),
        depends_on: [],
      }, {
        role: "implementer",
        goal,
        max_steps: 30,
        packet: packet({
          contract_json: {
            inputs: ["findings_report"],
            outputs: ["candidate_patch"],
            file_ownership: ["**/*"],
            acceptance_criteria: ["Implement the requested change"],
            non_goals: [],
          },
          acceptance_criteria: ["Implement the requested change"],
          constraints: ["Preserve current public behavior unless the goal requires otherwise"],
          success_criteria: ["Produce a candidate patch artifact"],
        }),
        depends_on: [0],
      }],
    };
  }
  return {
    reasoning: `Larger repo (${fileCount} files) — analyze first, then implement.`,
    accepted_assumptions: ["The codebase is large enough that scoped reconnaissance will reduce risk."],
    parallelism_notes: ["Read-only reconnaissance can parallelize later when the manager identifies independent areas."],
    tasks: [
      {
        role: "scout",
        goal: `Analyze existing code for: ${goal}`,
        max_steps: 20,
        packet: packet({
          contract_json: {
            inputs: [],
            outputs: ["findings_report"],
            file_ownership: [],
            acceptance_criteria: ["Return relevant files, tests, and analogous patterns"],
            non_goals: [],
          },
          acceptance_criteria: ["Return relevant files, tests, and analogous patterns"],
          success_criteria: ["Produce a findings_report artifact"],
        }),
        depends_on: [],
      },
      {
        role: "implementer",
        goal: `Implement changes for: ${goal}`,
        max_steps: 30,
        packet: packet({
          contract_json: {
            inputs: ["findings_report"],
            outputs: ["candidate_patch"],
            file_ownership: ["**/*"],
            acceptance_criteria: ["Implement the requested change"],
            non_goals: [],
          },
          acceptance_criteria: ["Implement the requested change"],
          success_criteria: ["Produce a candidate patch artifact"],
        }),
        depends_on: [0],
      },
    ],
  };
}

function tasksOverlap(a: PlannedWorkerTask, b: PlannedWorkerTask): boolean {
  const aFiles = new Set(a.packet.files || []);
  const bFiles = new Set(b.packet.files || []);
  if (aFiles.size === 0 || bFiles.size === 0) return true;
  for (const file of aFiles) {
    if (bFiles.has(file)) return true;
  }
  return false;
}

function ensureSummarizer(plan: ManagerPlan): ManagerPlan {
  if (plan.tasks.some((task) => task.role === "summarizer")) return plan;
  const depends_on = plan.tasks.map((_, idx) => idx);
  return {
    ...plan,
    tasks: [
      ...plan.tasks,
      {
        role: "summarizer",
        goal: "Summarize the manager plan outcomes and worker artifacts into a concise final handoff.",
        packet: packet({
          contract_json: {
            inputs: plan.tasks.map((task) => expectedArtifactTypeForRole(task.role)),
            outputs: ["final_summary"],
            file_ownership: [],
            acceptance_criteria: ["Summarize completed work, risks, and next steps"],
            non_goals: ["Do not invent code changes that workers did not make"],
          },
          acceptance_criteria: ["Summarize completed work, risks, and next steps"],
          non_goals: ["Do not invent code changes that workers did not make"],
          constraints: ["Use worker artifacts as the primary source of truth"],
          success_criteria: ["Produce a final_summary artifact"],
        }),
        max_steps: 8,
        depends_on,
      },
    ],
  };
}

function dropRedundantPlannedVerifiers(plan: ManagerPlan): ManagerPlan {
  const hasImplementer = plan.tasks.some((task) => task.role === "implementer");
  const hasVerifier = plan.tasks.some((task) => task.role === "verifier");
  if (!hasImplementer || !hasVerifier) return plan;

  const keptIndices = plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.role !== "verifier");
  const indexMap = new Map<number, number>();
  keptIndices.forEach(({ index }, newIndex) => indexMap.set(index, newIndex));

  return {
    ...plan,
    reasoning: `${plan.reasoning} [Dropped manager-planned verifier tasks because implementers already trigger verifier follow-ups.]`,
    tasks: keptIndices.map(({ task }) => ({
      ...task,
      depends_on: (task.depends_on || [])
        .filter((dep) => indexMap.has(dep))
        .map((dep) => indexMap.get(dep) as number),
    })),
  };
}

function dropGreenfieldScouts(plan: ManagerPlan): ManagerPlan {
  const hasScout = plan.tasks.some((task) => task.role === "scout");
  if (!hasScout) return plan;
  const keptIndices = plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.role !== "scout");
  const indexMap = new Map<number, number>();
  keptIndices.forEach(({ index }, newIndex) => indexMap.set(index, newIndex));
  return {
    ...plan,
    reasoning: `${plan.reasoning} [Dropped greenfield scout tasks because an empty repo has no existing code to inspect and the implementer can bootstrap directly.]`,
    tasks: keptIndices.map(({ task }) => ({
      ...task,
      depends_on: (task.depends_on || [])
        .filter((dep) => indexMap.has(dep))
        .map((dep) => indexMap.get(dep) as number),
    })),
  };
}

function validateParallelism(plan: ManagerPlan, goal: string, isEmpty: boolean, fileCount: number): ManagerPlan {
  let adjusted = normalizePlanContracts(plan);

  if (isEmpty) {
    adjusted = dropGreenfieldScouts(adjusted);
    adjusted = {
      ...adjusted,
      tasks: adjusted.tasks.map((task) =>
        task.role === "implementer"
          ? { ...task, max_steps: Math.max(task.max_steps || 20, 40) }
          : task
      ),
    };
  }

  const tasks = adjusted.tasks;
  if (tasks.length <= 1) {
    const validated = validatePlanContracts(adjusted);
    if (validated.ok) return validated.plan;
    return normalizePlanContracts(fallbackPlan(goal, isEmpty, fileCount));
  }

  adjusted = ensureSummarizer(dropRedundantPlannedVerifiers(adjusted));

  if (isEmpty) {
    const implementers = adjusted.tasks.filter((t) => t.role === "implementer");
    const hasDependencyChain = implementers.some((t) => t.depends_on && t.depends_on.length > 0);
    if (implementers.length > 1 && !hasDependencyChain) {
      const collapsed = ensureSummarizer(fallbackPlan(goal, true, fileCount));
      return {
        ...collapsed,
        reasoning: `${collapsed.reasoning} [Collapsed ${implementers.length} greenfield implementers into one because isolated worktrees cannot rely on sibling code being merged first. Tip: planner can use depends_on chains to allow sequential greenfield implementers.]`,
        accepted_assumptions: Array.from(
          new Set([...collapsed.accepted_assumptions, ...adjusted.accepted_assumptions])
        ),
        parallelism_notes: Array.from(
          new Set([...collapsed.parallelism_notes, ...adjusted.parallelism_notes])
        ),
      };
    }
  }

  if (adjusted.tasks.length > 7) {
    adjusted = {
      ...adjusted,
      reasoning: `${adjusted.reasoning} [Capped from ${adjusted.tasks.length} to 7 tasks]`,
      tasks: adjusted.tasks.slice(0, 7),
    };
  }

  const validated = validatePlanContracts(adjusted);
  if (!validated.ok) {
    const collapsed = normalizePlanContracts(fallbackPlan(goal, isEmpty, fileCount));
    return {
      ...collapsed,
      reasoning: `${collapsed.reasoning} [Collapsed invalid plan because ${validated.reason}]`,
    };
  }

  const parallelImpl = validated.plan.tasks.filter((t) => t.role === "implementer" && (!t.depends_on || t.depends_on.length === 0));
  if (parallelImpl.length > 1) {
    const disjoint = parallelImpl.every((task, index) =>
      parallelImpl.slice(index + 1).every((other) => !tasksOverlap(task, other))
    );
    if (disjoint) {
      return validated.plan;
    }
    const implGoal = parallelImpl.map((t) => t.goal).join("; ");
    const mergedFiles = Array.from(new Set(parallelImpl.flatMap((t) => t.packet.files || [])));
    const otherTasks = validated.plan.tasks.filter((t) => !(t.role === "implementer" && (!t.depends_on || t.depends_on.length === 0)));
    const mergedImpl: PlannedWorkerTask = {
      role: "implementer",
      goal: implGoal,
      max_steps: Math.max(...parallelImpl.map((t) => t.max_steps || 20), 30),
      packet: packet({
        files: mergedFiles,
        contract_json: {
          inputs: [],
          outputs: ["candidate_patch"],
          file_ownership: mergedFiles.length > 0 ? mergedFiles : ["**/*"],
          acceptance_criteria: ["Implement the requested changes without scope conflicts"],
          non_goals: [],
        },
        acceptance_criteria: ["Implement the requested changes without scope conflicts"],
        constraints: ["Keep all coupled edits in one implementer worktree"],
        success_criteria: ["Produce a candidate patch artifact"],
      }),
      depends_on: otherTasks.length > 0 ? otherTasks.map((_, i) => i) : [],
    };
    return {
      ...validated.plan,
      reasoning: `${validated.plan.reasoning} [Merged ${parallelImpl.length} parallel implementers because their ownership was not independent]`,
      tasks: [...otherTasks, mergedImpl],
    };
  }

  return validated.plan;
}

function roleToTaskKind(role: WorkerRole): TaskKind {
  switch (role) {
    case "implementer":
      return "patch_writer";
    case "verifier":
      return "verifier";
    case "summarizer":
      return "reducer";
    case "scout":
    case "reviewer":
      return "analysis";
  }
}

function roleToAllowedTools(role: WorkerRole): string[] {
  switch (role) {
    case "implementer":
      return IMPLEMENTATION_TOOLS;
    case "verifier":
      return VERIFIER_TOOLS;
    case "summarizer":
      return [];
    case "scout":
    case "reviewer":
      return ANALYSIS_TOOLS;
  }
}

function roleToWriteMode(role: WorkerRole): "none" | "worktree" {
  return role === "implementer" ? "worktree" : "none";
}

function roleToWorkspaceMode(role: WorkerRole): "shared_read_only" | "isolated_worktree" {
  return role === "implementer" ? "isolated_worktree" : "shared_read_only";
}

function roleToMaxTokens(role: WorkerRole): number {
  switch (role) {
    case "implementer":
      return 200000;
    case "scout":
    case "reviewer":
      return 100000;
    case "verifier":
      return 24000;
    case "summarizer":
      return 32000;
  }
}

export async function runPlanner(job: JobRow, appWorkspaceRoot: string): Promise<PlanResult> {
  const defaultP = job.default_model_provider as ModelProviderName;
  const plannerP = (job.planner_model_provider as ModelProviderName) || defaultP;
  const rootTaskId = findRootTaskForJob(job.id)?.id ?? null;

  updateJob(job.id, { status: "planning" });
  const managerTaskId = insertTask({
    job_id: job.id,
    parent_task_id: rootTaskId,
    kind: "planner",
    role: "manager",
    goal: `Create the canonical worker plan for: ${job.user_goal}`,
    scope_json: JSON.stringify({
      acceptance_criteria: ["Return a typed, dependency-aware worker plan"],
      non_goals: ["Do not execute worker tasks directly"],
      constraints: ["Only parallelize independent work"],
      success_criteria: ["Produce a manager_plan artifact"],
    }),
    status: "running",
    priority: 999,
    assigned_model_provider: plannerP,
    write_mode: "none",
    workspace_repo_mode: "shared_read_only",
    scratchpad_path: "",
    worktree_path: null,
    git_branch: "",
    base_ref: "",
    runtime_json: "{}",
    max_steps: 1,
    max_tokens: 12000,
    current_action: "planning",
    next_action: "fan_out",
    blocker: "",
    confidence: 0,
    files_examined_json: "[]",
    findings_json: "[]",
    open_questions_json: "[]",
    dependencies_json: "[]",
    allowed_tools_json: "[]",
    artifact_type: "manager_plan",
  });
  updateTask(managerTaskId, { scratchpad_path: scratchPath(appWorkspaceRoot, job.id, managerTaskId) });
  insertEvent({
    job_id: job.id,
    task_id: managerTaskId,
    level: "info",
    type: "planner_start",
    message: "Planner scanning repo and deciding tasks",
    data_json: JSON.stringify({ goal: job.user_goal, provider: plannerP }),
  });

  const { files, isEmpty } = quickRepoScan(job.repo_path);
  insertEvent({
    job_id: job.id,
    task_id: managerTaskId,
    level: "info",
    type: "planner_repo_scan",
    message: `Repo scan: ${files.length} files${isEmpty ? " (empty repo)" : ""}`,
    data_json: JSON.stringify({ fileCount: files.length, isEmpty, sample: files.slice(0, 30) }),
  });

  let plan: ManagerPlan;
  const { memoryContext } = getPlannerContext(job.repo_path, job.user_goal);
  const { system, user } = buildPlannerPrompt(job.user_goal, job.operator_notes, files, isEmpty, memoryContext);

  insertEvent({
    job_id: job.id,
    task_id: managerTaskId,
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
      task_id: managerTaskId,
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
      plan = normalizePlanContracts(parsed);
    } else {
      insertEvent({
        job_id: job.id,
        task_id: managerTaskId,
        level: "warn",
        type: "planner_parse_fallback",
        message: "Could not parse LLM plan, using fallback",
        data_json: JSON.stringify({ raw: resp.text.slice(0, 2000) }),
      });
      plan = normalizePlanContracts(fallbackPlan(job.user_goal, isEmpty, files.length));
    }
  } catch (e) {
    insertEvent({
      job_id: job.id,
      task_id: managerTaskId,
      level: "warn",
      type: "planner_error_fallback",
      message: `LLM planner failed (${String(e)}), using fallback`,
    });
    plan = normalizePlanContracts(fallbackPlan(job.user_goal, isEmpty, files.length));
  }

  // Validate: enforce sensible parallelism
  const originalCount = plan.tasks.length;
  plan = validateParallelism(plan, job.user_goal, isEmpty, files.length);
  if (plan.tasks.length !== originalCount) {
    insertEvent({
      job_id: job.id,
      task_id: managerTaskId,
      level: "info",
      type: "planner_adjusted",
      message: `Adjusted plan from ${originalCount} to ${plan.tasks.length} tasks (parallelism check)`,
      data_json: JSON.stringify({ originalCount, newCount: plan.tasks.length }),
    });
  }

  insertEvent({
    job_id: job.id,
    task_id: managerTaskId,
    level: "info",
    type: "planner_reasoning",
    message: plan.reasoning,
    data_json: JSON.stringify({
      reasoning: plan.reasoning,
      accepted_assumptions: plan.accepted_assumptions,
      parallelism_notes: plan.parallelism_notes,
      taskCount: plan.tasks.length,
      tasks: plan.tasks.map((t) => ({ role: t.role, goal: t.goal, packet: t.packet })),
    }),
  });

  insertArtifact({
    job_id: job.id,
    task_id: managerTaskId,
    type: "manager_plan",
    content_json: JSON.stringify(plan),
    confidence: 0.85,
  });

  const taskIds: number[] = [];
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const kind = roleToTaskKind(t.role);
    const deps = (t.depends_on || []).map((idx) => taskIds[idx]).filter((id) => id != null);
    const hasDeps = deps.length > 0;

    if (t.speculative_approaches && t.speculative_approaches.length >= 2 && t.role === "implementer") {
      const normalizedPacket = normalizeWorkerPacket(t.packet || {}, t.role);
      const group = startSpeculativeGroup(job.id, t.goal, t.speculative_approaches, rootTaskId, appWorkspaceRoot, {
        scope_json: JSON.stringify(normalizedPacket),
        assigned_model_provider: defaultP,
        allowed_tools_json: JSON.stringify(roleToAllowedTools(t.role)),
        priority: plan.tasks.length - i,
        max_steps: Math.max(20, t.max_steps || 20),
        max_tokens: 200_000,
        base_ref: "",
      });
      taskIds.push(group.candidateTaskIds[0]);
      insertEvent({
        job_id: job.id,
        task_id: managerTaskId,
        level: "info",
        type: "speculative_group_planned",
        message: `Spawned best-of-${t.speculative_approaches.length} speculative group for: ${t.goal.slice(0, 100)}`,
        data_json: JSON.stringify({ groupId: group.groupId, candidateTaskIds: group.candidateTaskIds, approaches: t.speculative_approaches }),
      });
      continue;
    }

    const id = insertTask({
      job_id: job.id,
      parent_task_id: rootTaskId,
      kind,
      role: t.role,
      goal: t.goal,
      scope_json: JSON.stringify(normalizeWorkerPacket(t.packet || {}, t.role)),
      status: hasDeps ? "blocked" : "queued",
      priority: plan.tasks.length - i,
      assigned_model_provider: defaultP,
      write_mode: roleToWriteMode(t.role),
      workspace_repo_mode: roleToWorkspaceMode(t.role),
      scratchpad_path: "",
      worktree_path: null,
      git_branch: "",
      base_ref: "",
      runtime_json: "{}",
      max_steps: t.max_steps || (t.role === "implementer" ? 50 : 20),
      max_tokens: roleToMaxTokens(t.role),
      current_action: hasDeps ? "blocked" : "queued",
      next_action: hasDeps ? "wait_deps" : "start",
      blocker: hasDeps ? "waiting for dependencies" : "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: JSON.stringify(deps),
      allowed_tools_json: JSON.stringify(roleToAllowedTools(t.role)),
      artifact_type: expectedArtifactTypeForRole(t.role),
    });
    taskIds.push(id);
  }

  for (const tid of taskIds) {
    updateTask(tid, { scratchpad_path: scratchPath(appWorkspaceRoot, job.id, tid) });
  }

  insertEvent({
    job_id: job.id,
    task_id: managerTaskId,
    level: "info",
    type: "planner_done",
    message: `Created ${taskIds.length} tasks: ${plan.tasks.map((t) => t.role).join(", ")}`,
    data_json: JSON.stringify({ taskIds, reasoning: plan.reasoning }),
  });

  updateTask(managerTaskId, {
    status: "done",
    current_action: "planned",
    next_action: "",
    confidence: 0.85,
  });
  updateJob(job.id, { status: "running" });
  return { taskIds };
}

export const __plannerInternals = {
  buildPlannerPrompt,
  fallbackPlan,
  validateParallelism,
};
