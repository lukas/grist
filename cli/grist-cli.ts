#!/usr/bin/env node
/**
 * Grist CLI — mirrors all UI interactions for scripting and testing.
 * Usage: node dist-electron/grist-cli.js <command> [options]
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { openDatabase, closeDatabase } from "../backend/db/db.js";
import { loadDotenvFile } from "../backend/settings/loadDotenv.js";
import { loadAppSettings } from "../backend/settings/appSettings.js";
import { GristOrchestrator } from "../backend/orchestrator/appOrchestrator.js";
import { getJob, listJobs } from "../backend/db/jobRepo.js";
import { listTasksForJob, getTask } from "../backend/db/taskRepo.js";
import { insertEvent, listEventsForTask, listJobLevelEvents, listEvents, listErrorEvents, countEventsByType, listEventsByType, listEventsByTaskId } from "../backend/db/eventRepo.js";
import { createRootTask, listRootTasks, getRootTask, rootTaskToJobId, getChildTasks } from "../backend/db/rootTaskFacade.js";
import {
  getFullMemoryData,
  readHomeMemoryFile,
  readRepoMemoryFile,
  readHomeSummary,
  readRepoSummary,
  writeHomeSummary,
  writeRepoSummary,
  ensureHomeMemory,
  ensureRepoMemory,
} from "../backend/memory/memoryManager.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runSkillsCli } from "./skillsCliCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Init ---

function initDb(): void {
  const dataDir = join(homedir(), "Library", "Application Support", "Grist");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "grist.sqlite");
  openDatabase(dbPath);
}

function initEnv(): void {
  loadDotenvFile([
    join(__dirname, "..", ".env"),
    join(process.cwd(), ".env"),
  ]);
}

function getWorkspaceRoot(): string {
  const dir = join(homedir(), "Library", "Application Support", "Grist", "workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Formatting helpers ---

function table(rows: Record<string, unknown>[], cols?: string[]): void {
  if (rows.length === 0) { console.log("(empty)"); return; }
  const keys = cols ?? Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(keys.map((_, i) => "─".repeat(widths[i])).join("──"));
  for (const r of rows) {
    console.log(keys.map((k, i) => String(r[k] ?? "").padEnd(widths[i])).join("  "));
  }
}

function json(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

// --- Commands ---

const commands: Record<string, { help: string; run: (args: string[]) => Promise<void> }> = {
  // --- Job lifecycle ---
  run: {
    help: "run --repo <path> --goal <text> [--notes <text>]  Create task, plan, start scheduler, and watch",
    run: async (args) => {
      const repo = resolve(flagVal(args, "--repo") || process.cwd());
      const goal = flagVal(args, "--goal") || args.filter((a) => !a.startsWith("--")).join(" ");
      const notes = flagVal(args, "--notes") || "";
      if (!goal) { console.error("Usage: grist run --repo <path> --goal <text>"); process.exit(1); }

      const settings = loadAppSettings();
      const orch = new GristOrchestrator(getWorkspaceRoot());

      console.log(`Creating task: repo=${repo} goal="${goal}"`);
      const rootTaskId = createRootTask({
        repoPath: repo,
        goal,
        notes,
        defaultProvider: settings.defaultProvider,
        plannerProvider: settings.plannerProvider,
      });
      const jobId = rootTaskToJobId(rootTaskId)!;
      console.log(`Task #${rootTaskId} created (job ${jobId})`);

      console.log("Running planner...");
      await orch.planJob(jobId);
      const children = getChildTasks(rootTaskId);
      const workerTasks = children.filter((t) => t.kind !== "planner");
      console.log(`Planner created ${workerTasks.length} task(s): ${workerTasks.map((t) => t.role).join(", ")}`);

      console.log("Starting scheduler...");
      orch.startScheduler(jobId);

      await watchJob(jobId, orch);
    },
  },

  "create-task": {
    help: "create-task --repo <path> --goal <text> [--notes <text>]",
    run: async (args) => {
      const repo = resolve(flagVal(args, "--repo") || process.cwd());
      const goal = flagVal(args, "--goal") || "";
      const notes = flagVal(args, "--notes") || "";
      if (!goal) { console.error("Usage: grist create-task --repo <path> --goal <text>"); process.exit(1); }

      const settings = loadAppSettings();
      const rootTaskId = createRootTask({
        repoPath: repo,
        goal,
        notes,
        defaultProvider: settings.defaultProvider,
        plannerProvider: settings.plannerProvider,
        reducerProvider: settings.reducerProvider,
        verifierProvider: settings.verifierProvider,
      });
      console.log(rootTaskId);
    },
  },

  plan: {
    help: "plan <taskId>  Run planner for a root task",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Root task #${rootTaskId} not found`); process.exit(1); }
      const orch = new GristOrchestrator(getWorkspaceRoot());
      await orch.planJob(jobId);
      const children = getChildTasks(rootTaskId);
      table(children.map((t) => ({ id: t.id, role: t.role, kind: t.kind, status: t.status, goal: t.goal.slice(0, 60) })));
    },
  },

  start: {
    help: "start <taskId>  Start the scheduler for a root task",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Root task #${rootTaskId} not found`); process.exit(1); }
      const orch = new GristOrchestrator(getWorkspaceRoot());
      orch.startScheduler(jobId);
      console.log(`Scheduler started for task #${rootTaskId}`);
      await watchJob(jobId, orch);
    },
  },

  // --- Queries ---
  list: {
    help: "list  List all root tasks",
    run: async () => {
      const roots = listRootTasks();
      if (roots.length === 0) { console.log("No tasks."); return; }
      table(roots.map((r) => ({
        id: r.id,
        status: r.status,
        goal: r.user_goal.slice(0, 50),
        repo: r.repo_path.split("/").slice(-2).join("/"),
      })));
    },
  },

  subtasks: {
    help: "subtasks <taskId>  List subtasks for a root task",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const children = getChildTasks(rootTaskId);
      if (children.length === 0) { console.log("No subtasks."); return; }
      table(children.map((t) => ({
        id: t.id,
        role: t.role,
        kind: t.kind,
        status: t.status,
        steps: `${t.steps_used}/${t.max_steps}`,
        tokens: t.tokens_used,
        branch: t.git_branch || "",
        goal: t.goal.slice(0, 50),
      })));
    },
  },

  events: {
    help: "events <rootTaskId> [--task <taskId>] [--limit <n>]  Show events",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Root task #${rootTaskId} not found`); process.exit(1); }
      const taskId = flagVal(args, "--task");
      const limit = parseInt(flagVal(args, "--limit") || "50", 10);
      const evs = taskId
        ? listEventsByTaskId(parseInt(taskId, 10), limit) as Record<string, unknown>[]
        : listEvents(jobId, limit) as Record<string, unknown>[];
      for (const e of evs) {
        const time = String(e.created_at ?? "").slice(11, 19);
        const tid = e.task_id ? `t${e.task_id}` : "root";
        console.log(`${time} [${tid}] ${e.type}: ${String(e.message ?? "").slice(0, 120)}`);
      }
    },
  },

  status: {
    help: "status <taskId>  Show root task + subtask statuses",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const root = getRootTask(rootTaskId);
      if (!root) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      console.log(`Task #${rootTaskId}: ${root.status}  "${root.user_goal}"`);
      console.log(`  repo: ${root.repo_path}`);
      console.log(`  tokens: ${root.total_tokens_used}  cost: $${(root.total_estimated_cost || 0).toFixed(4)}`);
      console.log();
      const children = getChildTasks(rootTaskId);
      table(children.map((t) => ({
        id: t.id,
        role: t.role,
        kind: t.kind,
        status: t.status,
        steps: `${t.steps_used}/${t.max_steps}`,
        tokens: t.tokens_used,
        branch: t.git_branch || "",
        blocker: (t.blocker || "").slice(0, 40),
      })));
    },
  },

  "task-detail": {
    help: "task-detail <taskId>  Show full task info",
    run: async (args) => {
      const taskId = parseInt(args[0], 10);
      const task = getTask(taskId);
      if (!task) { console.error("Task not found"); process.exit(1); }
      json({
        id: task.id,
        role: task.role,
        kind: task.kind,
        status: task.status,
        goal: task.goal,
        steps: `${task.steps_used}/${task.max_steps}`,
        tokens: task.tokens_used,
        blocker: task.blocker,
        confidence: task.confidence,
        branch: task.git_branch,
        baseRef: task.base_ref,
        runtime: JSON.parse(task.runtime_json || "{}"),
        findings: JSON.parse(task.findings_json || "[]"),
      });
    },
  },

  // --- Control ---
  message: {
    help: "message <taskId> <text>  Send a message to a task",
    run: async (args) => {
      const taskId = parseInt(args[0], 10);
      const msg = args.slice(1).join(" ");
      if (!msg) { console.error("Usage: grist message <taskId> <text>"); process.exit(1); }
      const task = getTask(taskId);
      if (!task) { console.error("Task not found"); process.exit(1); }
      insertEvent({
        job_id: task.job_id,
        task_id: taskId,
        level: "info",
        type: "user_message",
        message: msg,
      });
      console.log(`Message sent to task #${taskId}`);
    },
  },

  respond: {
    help: "respond <taskId> <text>  Answer a question from an agent",
    run: async (args) => {
      const taskId = parseInt(args[0], 10);
      const msg = args.slice(1).join(" ");
      if (!msg) { console.error("Usage: grist respond <taskId> <answer>"); process.exit(1); }
      const task = getTask(taskId);
      if (!task) { console.error("Task not found"); process.exit(1); }
      insertEvent({
        job_id: task.job_id,
        task_id: taskId,
        level: "info",
        type: "user_message",
        message: msg,
      });
      console.log(`Response sent to task #${taskId} (status: ${task.status})`);
    },
  },

  questions: {
    help: "questions  Show all tasks waiting for user input",
    run: async () => {
      const roots = listRootTasks();
      const waiting: { rootId: number; taskId: number; role: string; question: string; goal: string }[] = [];
      for (const r of roots) {
        if (["done", "stopped", "failed"].includes(r.status)) continue;
        const children = getChildTasks(r.id);
        for (const t of children) {
          if (t.status === "waiting_for_user") {
            waiting.push({ rootId: r.id, taskId: t.id, role: t.role, question: t.blocker, goal: r.user_goal.slice(0, 40) });
          }
        }
      }
      if (waiting.length === 0) { console.log("No tasks are waiting for user input."); return; }
      for (const w of waiting) {
        console.log(`\nTask #${w.rootId} (${w.goal}) → Subtask #${w.taskId} (${w.role})`);
        console.log(`  Question: ${w.question}`);
        console.log(`  Respond:  grist respond ${w.taskId} "<your answer>"`);
      }
    },
  },

  pause: {
    help: "pause <taskId>  Pause all subtasks",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const orch = new GristOrchestrator(getWorkspaceRoot());
      orch.jobControl({ type: "pause_all", jobId });
      console.log(`Task #${rootTaskId} paused`);
    },
  },

  resume: {
    help: "resume <taskId>  Resume all subtasks",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const orch = new GristOrchestrator(getWorkspaceRoot());
      orch.jobControl({ type: "resume_all", jobId });
      orch.startScheduler(jobId);
      console.log(`Task #${rootTaskId} resumed`);
    },
  },

  stop: {
    help: "stop <taskId>  Stop a task and all subtasks",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const orch = new GristOrchestrator(getWorkspaceRoot());
      orch.jobControl({ type: "stop_run", jobId });
      console.log(`Task #${rootTaskId} stopped`);
    },
  },

  // --- Memory ---
  memory: {
    help: "memory [--repo <path>]  Show memory summaries and file list",
    run: async (args) => {
      const repo = resolve(flagVal(args, "--repo") || process.cwd());
      ensureHomeMemory();
      if (existsSync(repo)) ensureRepoMemory(repo);

      const data = getFullMemoryData(repo);

      console.log("=== Project Summary ===");
      console.log(data.repoSummary || "(empty)");
      console.log();
      console.log(`=== Project Notes (${data.repoFiles.length}) ===`);
      for (const f of data.repoFiles) {
        console.log(`  ${f.name}  (${f.content.length} chars)`);
      }
      console.log();
      console.log("=== Global Summary ===");
      console.log(data.homeSummary || "(empty)");
      console.log();
      console.log(`=== Global Notes (${data.homeFiles.length}) ===`);
      for (const f of data.homeFiles) {
        console.log(`  ${f.name}  (${f.content.length} chars)`);
      }
    },
  },

  "memory-read": {
    help: "memory-read <scope> <filename> [--repo <path>]  Read a memory file",
    run: async (args) => {
      const scope = args[0]; // "project" or "global"
      const name = args[1];
      const repo = resolve(flagVal(args, "--repo") || process.cwd());
      if (!scope || !name) { console.error("Usage: grist memory-read <project|global> <filename>"); process.exit(1); }
      const content = scope === "global"
        ? readHomeMemoryFile(name)
        : readRepoMemoryFile(repo, name);
      console.log(content || "(empty)");
    },
  },

  "memory-update": {
    help: "memory-update <scope> <content> [--repo <path>]  Update a summary",
    run: async (args) => {
      const scope = args[0];
      const content = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      const repo = resolve(flagVal(args, "--repo") || process.cwd());
      if (scope === "global") writeHomeSummary(content);
      else writeRepoSummary(repo, content);
      console.log(`${scope} summary updated`);
    },
  },

  // --- Watch ---
  watch: {
    help: "watch <taskId> [--subtask <taskId>]  Tail events in real-time",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const taskFilter = flagVal(args, "--subtask") ? parseInt(flagVal(args, "--subtask")!, 10) : null;
      const orch = new GristOrchestrator(getWorkspaceRoot());
      orch.startScheduler(jobId);
      await watchJob(jobId, orch, taskFilter);
    },
  },

  // --- Analysis ---
  summary: {
    help: "summary <taskId>  Structured post-run report for reflection",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const root = getRootTask(rootTaskId);
      if (!root) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const jobId = root._jobId;
      const job = getJob(jobId);
      if (!job) { console.error(`Underlying job not found`); process.exit(1); }

      const tasks = listTasksForJob(jobId);
      const eventCounts = countEventsByType(jobId);
      const errors = listErrorEvents(jobId) as { task_id: number | null; type: string; message: string; created_at: string }[];
      const modelResponses = listEventsByType(jobId, "model_response") as { data_json: string | null; task_id: number }[];
      const taskDones = listEventsByType(jobId, "task_done") as { data_json: string | null; message: string; task_id: number }[];
      const diffs = listEventsByType(jobId, "task_diff") as { data_json: string | null; message: string; task_id: number }[];

      // Compute per-step timing and cost
      let totalLlmMs = 0;
      let totalToolMs = 0;
      let totalStepCost = 0;
      let maxStepMs = 0;
      for (const ev of modelResponses) {
        if (!ev.data_json) continue;
        try {
          const d = JSON.parse(ev.data_json) as { durationMs?: number; estimatedCost?: number };
          if (d.durationMs) { totalLlmMs += d.durationMs; maxStepMs = Math.max(maxStepMs, d.durationMs); }
          if (d.estimatedCost) totalStepCost += d.estimatedCost;
        } catch { /* skip */ }
      }
      const toolResults = listEventsByType(jobId, "tool_result") as { data_json: string | null }[];
      for (const ev of toolResults) {
        if (!ev.data_json) continue;
        try {
          const d = JSON.parse(ev.data_json) as { durationMs?: number };
          if (d.durationMs) totalToolMs += d.durationMs;
        } catch { /* skip */ }
      }

      const jobStart = new Date(job.created_at).getTime();
      const jobEnd = new Date(job.updated_at).getTime();
      const wallClockSec = Math.round((jobEnd - jobStart) / 1000);

      console.log("═══════════════════════════════════════════════════");
      console.log(`  TASK #${rootTaskId} SUMMARY`);
      console.log("═══════════════════════════════════════════════════");
      console.log(`  Goal:     ${job.user_goal}`);
      console.log(`  Repo:     ${job.repo_path}`);
      console.log(`  Status:   ${job.status}`);
      console.log(`  Provider: ${job.default_model_provider}`);
      console.log();
      console.log("  ── Timing ──");
      console.log(`  Wall clock:      ${wallClockSec}s`);
      console.log(`  LLM time:        ${Math.round(totalLlmMs / 1000)}s (slowest step: ${Math.round(maxStepMs / 1000)}s)`);
      console.log(`  Tool time:       ${Math.round(totalToolMs / 1000)}s`);
      console.log();
      console.log("  ── Cost ──");
      console.log(`  Total tokens:    ${job.total_tokens_used}`);
      console.log(`  Estimated cost:  $${(job.total_estimated_cost || 0).toFixed(4)}`);
      console.log(`  LLM calls:       ${modelResponses.length}`);
      console.log();
      console.log("  ── Tasks ──");
      for (const t of tasks) {
        const scopeObj = JSON.parse(t.scope_json || "{}") as Record<string, unknown>;
        const fmod = (scopeObj.files_modified as string[]) || [];
        const indicator = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : t.status === "running" ? "⟳" : "·";
        console.log(`  ${indicator} ${t.role} (${t.status}) — ${t.steps_used}/${t.max_steps} steps, ${t.tokens_used} tok`);
        if (fmod.length) console.log(`    files modified: ${fmod.join(", ")}`);
        if (t.blocker) console.log(`    blocker: ${t.blocker}`);
      }
      console.log();
      console.log("  ── Event Breakdown ──");
      for (const ec of eventCounts.slice(0, 15)) {
        console.log(`  ${String(ec.count).padStart(4)}× ${ec.type}`);
      }
      if (errors.length > 0) {
        console.log();
        console.log(`  ── Errors & Warnings (${errors.length}) ──`);
        for (const e of errors.slice(0, 10)) {
          const time = String(e.created_at).slice(11, 19);
          const tid = e.task_id ? `t${e.task_id}` : "job";
          console.log(`  ${time} [${tid}] ${e.type}: ${e.message.slice(0, 100)}`);
        }
        if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);
      }
      if (diffs.length > 0) {
        console.log();
        console.log("  ── Git Diffs ──");
        for (const d of diffs) {
          console.log(`  task ${d.task_id}: ${d.message}`);
        }
      }

      // Task completion summaries
      if (taskDones.length > 0) {
        console.log();
        console.log("  ── Task Outcomes ──");
        for (const td of taskDones) {
          const task = tasks.find((t) => t.id === td.task_id);
          let metrics = "";
          if (td.data_json) {
            try {
              const d = JSON.parse(td.data_json) as Record<string, unknown>;
              if (d.stepsUsed) metrics = ` [${d.stepsUsed}/${d.maxSteps} steps, ${d.tokensUsed} tok, ${Math.round((d.wallClockMs as number) / 1000)}s]`;
            } catch { /* skip */ }
          }
          console.log(`  ${task?.role || `task ${td.task_id}`}${metrics}`);
          console.log(`    ${td.message.slice(0, 200)}`);
        }
      }
      console.log();
      console.log("═══════════════════════════════════════════════════");
    },
  },

  errors: {
    help: "errors <taskId>  Show all errors and warnings",
    run: async (args) => {
      const rootTaskId = parseInt(args[0], 10);
      const jobId = rootTaskToJobId(rootTaskId);
      if (!jobId) { console.error(`Task #${rootTaskId} not found`); process.exit(1); }
      const errs = listErrorEvents(jobId) as { task_id: number | null; type: string; message: string; created_at: string; level: string }[];
      if (errs.length === 0) { console.log("No errors or warnings."); return; }
      for (const e of errs) {
        const time = String(e.created_at).slice(11, 19);
        const tid = e.task_id ? `t${e.task_id}` : "job";
        const marker = e.level === "error" ? "ERR" : "WRN";
        console.log(`${time} [${marker}] [${tid}] ${e.type}: ${e.message.slice(0, 150)}`);
      }
    },
  },

  // --- Settings ---
  settings: {
    help: "settings  Show current settings (redacted keys)",
    run: async () => {
      const s = loadAppSettings();
      const redacted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "string" && (k.toLowerCase().includes("key") || k.toLowerCase().includes("secret"))) {
          redacted[k] = v ? `${v.slice(0, 4)}...${v.slice(-4)}` : "(not set)";
        } else {
          redacted[k] = v;
        }
      }
      json(redacted);
    },
  },

  skills: {
    help: "skills <subcommand> ...  Manage global and project skills",
    run: async (args) => {
      await runSkillsCli(args);
    },
  },
};

// --- Watch loop ---

async function watchJob(jobId: number, orch: GristOrchestrator, taskFilter?: number | null): Promise<void> {
  let lastEventId = 0;
  const seen = new Set<number>();

  const poll = () => {
    const evs = (taskFilter
      ? listEventsForTask(jobId, taskFilter, 500)
      : listEvents(jobId, 500)
    ) as { id: number; task_id: number | null; type: string; message: string; created_at: string }[];

    for (const e of evs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const time = String(e.created_at ?? "").slice(11, 19);
      const tid = e.task_id ? `t${e.task_id}` : "job";
      const msg = String(e.message ?? "").slice(0, 150);
      console.log(`${time} [${tid}] ${e.type}: ${msg}`);
      lastEventId = Math.max(lastEventId, e.id);
    }

    const job = getJob(jobId);
    if (job && ["completed", "failed", "stopped"].includes(job.status)) {
      console.log(`\nJob #${jobId} finished: ${job.status}`);
      const tasks = listTasksForJob(jobId);
      console.log(`  Tasks: ${tasks.map((t) => `${t.role}(${t.status})`).join(", ")}`);
      console.log(`  Tokens: ${job.total_tokens_used}  Cost: $${(job.total_estimated_cost || 0).toFixed(4)}`);
      orch.stopScheduler(jobId);
      return true;
    }
    return false;
  };

  // Initial dump
  poll();

  // Poll loop
  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    if (poll()) break;
  }
}

// --- Arg parsing ---

function flagVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// --- Main ---

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log("Grist CLI — all UI interactions as commands\n");
  console.log("Usage: grist <command> [options]\n");
  console.log("Commands:");
  for (const [name, { help }] of Object.entries(commands)) {
    console.log(`  ${help}`);
  }
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}. Run 'grist help' for usage.`);
  process.exit(1);
}

initEnv();
initDb();
commands[cmd].run(args.slice(1))
  .then(() => {
    closeDatabase();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    closeDatabase();
    process.exit(1);
  });
