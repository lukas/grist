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
} from "../types/taskState.js";

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

function buildPlannerPrompt(goal: string, operatorNotes: string, files: string[], isEmpty: boolean): { system: string; user: string } {
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
        "acceptance_criteria": ["what done means"],
        "non_goals": ["what not to do"],
        "similar_patterns": ["paths or symbols to mimic"],
        "constraints": ["backward compatibility, APIs, style, etc"],
        "commands_allowed": ["npm run typecheck"],
        "success_criteria": ["artifact or verification expectations"]
      },
      "max_steps": 20,
      "depends_on": [0]
    }
  ]
}

Requirements:
- depends_on is 0-indexed into the tasks array.
- Implementers MUST set packet.files when they edit code.
- If two implementers would touch the same files, merge them into one task.
- Scouts/reviewers should be read-only.
- Verifiers should depend on the implementer they validate.
- Summarizer should depend on all worker tasks it summarizes.`;

  const filesSummary = isEmpty
    ? "The repository is EMPTY (no files). This is a brand new project."
    : `Repository contains ${files.length}${files.length >= 200 ? "+" : ""} files:\n${files.join("\n")}`;

  const user = `User goal: ${goal}
${operatorNotes ? `Operator notes: ${operatorNotes}\n` : ""}
${filesSummary}`;

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

function extractExplicitFiles(goal: string): string[] {
  return Array.from(
    new Set(
      Array.from(goal.matchAll(/\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g), (m) => m[1])
        .filter((f) => !f.startsWith("http://") && !f.startsWith("https://"))
    )
  );
}

function buildGreenfieldFallbackTasks(goal: string): FallbackTask[] | null {
  const files = extractExplicitFiles(goal);
  if (files.length < 2) return null;

  const architectScope = ["ARCHITECTURE.md"];
  const tasks: FallbackTask[] = [
    {
      role: "implementer",
      goal: `Define module structure and shared interfaces for: ${goal}. Create a brief ARCHITECTURE.md covering file responsibilities and shared contracts.`,
      max_steps: 5,
      packet: packet({
        files: architectScope,
        area: "shared architecture",
        acceptance_criteria: ["Create a concise architecture contract for downstream workers"],
        non_goals: ["Do not implement feature modules yet"],
        constraints: ["Only modify shared contract files"],
        success_criteria: ["Downstream workers can implement their files independently"],
      }),
      depends_on: [],
    },
  ];

  const integratorCandidates = files.filter((f) => /(^|\/)(index|main|app)\./i.test(f));
  const integratorFile = integratorCandidates[0];
  const leafFiles = integratorFile ? files.filter((f) => f !== integratorFile) : files;

  for (const file of leafFiles.slice(0, 4)) {
    tasks.push({
      role: "implementer",
      goal: `Implement ${file} for: ${goal}. Only modify ${file}.`,
      max_steps: 20,
      packet: packet({
        files: [file],
        area: file,
        acceptance_criteria: [`Implement ${file}`],
        non_goals: ["Do not modify unrelated files"],
        constraints: [`Only modify ${file}`],
        success_criteria: ["Produce a candidate patch artifact"],
      }),
      depends_on: [0],
    });
  }

  if (integratorFile && tasks.length < 6) {
    tasks.push({
      role: "implementer",
      goal: `Implement ${integratorFile} for: ${goal}. Wire together the other module files and only modify ${integratorFile}.`,
      max_steps: 20,
      packet: packet({
        files: [integratorFile],
        area: integratorFile,
        acceptance_criteria: [`Wire together the module files in ${integratorFile}`],
        non_goals: ["Do not rewrite leaf modules"],
        constraints: [`Only modify ${integratorFile}`],
        success_criteria: ["Produce a candidate patch artifact"],
      }),
      depends_on: Array.from({ length: tasks.length - 1 }, (_, i) => i + 1),
    });
  }

  return tasks;
}

function fallbackPlan(goal: string, isEmpty: boolean, fileCount: number): ManagerPlan {
  if (isEmpty) {
    const greenfieldTasks = buildGreenfieldFallbackTasks(goal);
    if (greenfieldTasks) {
      return {
        reasoning: `Empty repo with explicit module files — architect first, then parallel implementation by owned file${greenfieldTasks.length > 2 ? ", with a final integrator when needed" : ""}.`,
        accepted_assumptions: ["The requested file list is the intended project shape."],
        parallelism_notes: ["Parallel implementers are file-scoped and independent."],
        tasks: greenfieldTasks,
      };
    }
    return {
      reasoning: "Empty repo — architect defines structure, then implementer builds it.",
      accepted_assumptions: ["Greenfield repo can be bootstrapped from the user goal alone."],
      parallelism_notes: ["Work remains sequential because interfaces are not yet known."],
      tasks: [
        {
          role: "implementer",
          goal: `Define module structure and shared interfaces for: ${goal}. Create a brief ARCHITECTURE.md and any shared type/config files.`,
          max_steps: 5,
          packet: packet({
            files: ["ARCHITECTURE.md", "types.js"],
            area: "shared contracts",
            non_goals: ["Do not implement every feature yet"],
            success_criteria: ["Shared interfaces exist for later implementation"],
          }),
          depends_on: [],
        },
        {
          role: "implementer",
          goal: `Build the full project: ${goal}`,
          max_steps: 40,
          packet: packet({
            acceptance_criteria: ["Implement the requested project end-to-end"],
            success_criteria: ["Produce a candidate patch artifact"],
          }),
          depends_on: [0],
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
          acceptance_criteria: ["Return relevant files and analogous implementations"],
          success_criteria: ["Produce a findings_report artifact"],
        }),
        depends_on: [],
      }, {
        role: "implementer",
        goal,
        max_steps: 30,
        packet: packet({
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

function validateParallelism(plan: ManagerPlan, isEmpty: boolean, fileCount: number): ManagerPlan {
  const tasks = plan.tasks;
  if (tasks.length <= 1) return plan;

  let adjusted = ensureSummarizer(plan);

  if (adjusted.tasks.length > 7) {
    adjusted = {
      ...adjusted,
      reasoning: `${adjusted.reasoning} [Capped from ${adjusted.tasks.length} to 7 tasks]`,
      tasks: adjusted.tasks.slice(0, 7),
    };
  }

  const parallelImpl = adjusted.tasks.filter((t) => t.role === "implementer" && (!t.depends_on || t.depends_on.length === 0));
  if (parallelImpl.length > 1) {
    const disjoint = parallelImpl.every((task, index) =>
      parallelImpl.slice(index + 1).every((other) => !tasksOverlap(task, other))
    );
    if (disjoint) {
      return adjusted;
    }
    const implGoal = parallelImpl.map((t) => t.goal).join("; ");
    const mergedFiles = Array.from(new Set(parallelImpl.flatMap((t) => t.packet.files || [])));
    const otherTasks = adjusted.tasks.filter((t) => !(t.role === "implementer" && (!t.depends_on || t.depends_on.length === 0)));
    const mergedImpl: PlannedWorkerTask = {
      role: "implementer",
      goal: implGoal,
      max_steps: Math.max(...parallelImpl.map((t) => t.max_steps || 20), 30),
      packet: packet({
        files: mergedFiles,
        acceptance_criteria: ["Implement the requested changes without scope conflicts"],
        constraints: ["Keep all coupled edits in one implementer worktree"],
        success_criteria: ["Produce a candidate patch artifact"],
      }),
      depends_on: otherTasks.length > 0 ? otherTasks.map((_, i) => i) : [],
    };
    return {
      ...adjusted,
      reasoning: `${adjusted.reasoning} [Merged ${parallelImpl.length} parallel implementers because their ownership was not independent]`,
      tasks: [...otherTasks, mergedImpl],
    };
  }

  return adjusted;
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
  const { system, user } = buildPlannerPrompt(job.user_goal, job.operator_notes, files, isEmpty);

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
      plan = parsed;
    } else {
      insertEvent({
        job_id: job.id,
        task_id: managerTaskId,
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
      task_id: managerTaskId,
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

    const id = insertTask({
      job_id: job.id,
      parent_task_id: rootTaskId,
      kind,
      role: t.role,
      goal: t.goal,
      scope_json: JSON.stringify(t.packet || {}),
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
