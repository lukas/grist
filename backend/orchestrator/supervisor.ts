import { getTask, listTasksForJob, updateTask } from "../db/taskRepo.js";
import { listEventsByTaskId, insertEvent } from "../db/eventRepo.js";
import { getJob } from "../db/jobRepo.js";
import { createProvider } from "../providers/providerFactory.js";
import { loadAppSettings } from "../settings/appSettings.js";

const SUPERVISOR_INTERVAL_MS = 60_000;
const MIN_STEPS_BEFORE_REVIEW = 5;
const MAX_EVENTS_TO_REVIEW = 30;

interface SupervisorVerdict {
  action: "continue" | "warn" | "redirect" | "pause";
  reason: string;
  newGoal?: string;
}

const lastReviewStep = new Map<number, number>();

export function shouldReviewTask(taskId: number): boolean {
  const task = getTask(taskId);
  if (!task || task.status !== "running") return false;
  if (task.steps_used < MIN_STEPS_BEFORE_REVIEW) return false;
  const lastStep = lastReviewStep.get(taskId) || 0;
  if (task.steps_used - lastStep < 5) return false;
  return true;
}

function buildSupervisorPrompt(
  task: NonNullable<ReturnType<typeof getTask>>,
  events: Array<{ type: string; message: string; level: string }>,
  jobGoal: string,
): string {
  const recentEvents = events.slice(-MAX_EVENTS_TO_REVIEW)
    .map((e) => `[${e.level}/${e.type}] ${e.message.slice(0, 300)}`)
    .join("\n");

  return `You are a supervisor reviewing an agent's recent trajectory. Assess whether the agent is making productive progress.

Job goal: ${jobGoal}
Task goal: ${task.goal}
Task role: ${task.role}
Steps used: ${task.steps_used} / ${task.max_steps}
Tokens used: ${task.tokens_used} / ${task.max_tokens}
Current action: ${task.current_action}
Blocker: ${task.blocker || "(none)"}

Recent events (${events.length} total, showing last ${Math.min(events.length, MAX_EVENTS_TO_REVIEW)}):
${recentEvents}

Assess:
1. Is the agent making progress toward its goal?
2. Is the agent stuck in a loop (repeating similar actions)?
3. Is the agent doing unnecessary work outside its scope?
4. Has the agent spent a disproportionate amount of budget on exploration vs. delivery?

Respond with JSON:
{
  "action": "continue" | "warn" | "redirect" | "pause",
  "reason": "brief explanation",
  "newGoal": "optional new goal if redirecting"
}

- "continue": agent is on track
- "warn": agent might be drifting but not critically
- "redirect": agent should change approach (provide newGoal)
- "pause": agent is clearly stuck/looping, should stop for human review`;
}

export async function reviewTask(taskId: number): Promise<SupervisorVerdict | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const job = getJob(task.job_id);
  if (!job) return null;

  const events = (listEventsByTaskId(taskId, 100) as Array<{ type: string; message: string; level: string }>)
    .filter((e) => e.type !== "prompt");

  const settings = loadAppSettings();
  const provider = createProvider(job.planner_model_provider || job.default_model_provider, settings);

  const prompt = buildSupervisorPrompt(task, events, job.user_goal);

  try {
    const resp = await provider.generateText({
      systemPrompt: "You are a concise supervisor. Return only valid JSON.",
      userPrompt: prompt,
      maxTokens: 512,
      temperature: 0.1,
    });

    const parsed = JSON.parse(resp.text) as SupervisorVerdict;
    lastReviewStep.set(taskId, task.steps_used);
    return parsed;
  } catch {
    return null;
  }
}

export async function runSupervisorCheck(jobId: number): Promise<void> {
  const tasks = listTasksForJob(jobId);
  const running = tasks.filter((t) => t.status === "running" && t.kind !== "root" && t.role !== "manager");

  for (const task of running) {
    if (!shouldReviewTask(task.id)) continue;

    const verdict = await reviewTask(task.id);
    if (!verdict || verdict.action === "continue") continue;

    insertEvent({
      job_id: jobId,
      task_id: task.id,
      level: verdict.action === "pause" ? "warn" : "info",
      type: "supervisor_review",
      message: `Supervisor: ${verdict.action} — ${verdict.reason}`,
      data_json: JSON.stringify(verdict),
    });

    if (verdict.action === "warn") {
      continue;
    }

    if (verdict.action === "redirect" && verdict.newGoal) {
      insertEvent({
        job_id: jobId,
        task_id: task.id,
        level: "info",
        type: "user_message",
        message: `[Supervisor redirect] ${verdict.reason}\n\nNew direction: ${verdict.newGoal}`,
      });
      continue;
    }

    if (verdict.action === "pause") {
      updateTask(task.id, {
        status: "paused",
        blocker: `Supervisor paused: ${verdict.reason}`,
        next_action: "operator",
      });
    }
  }
}

export function cleanupSupervisorState(jobId: number): void {
  const tasks = listTasksForJob(jobId);
  for (const task of tasks) {
    lastReviewStep.delete(task.id);
  }
}

export { SUPERVISOR_INTERVAL_MS };
