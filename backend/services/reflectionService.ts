import { getJob } from "../db/jobRepo.js";
import { getLatestArtifactForTask } from "../db/artifactRepo.js";
import { insertEvent, listEventsForTask } from "../db/eventRepo.js";
import { getTask } from "../db/taskRepo.js";
import { loadAppSettings } from "../settings/appSettings.js";
import { createProvider } from "../providers/providerFactory.js";
import { runReflection } from "../orchestrator/reflection.js";
import { parseWorkerPacket } from "./contractService.js";

function shouldRunEpisodeReflection(taskId: number, verifierTaskId: number): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  const packet = parseWorkerPacket(task.scope_json, "implementer");
  if (packet.workflow_phase === "wrapup") return false;
  const patch = getLatestArtifactForTask(taskId, "candidate_patch") as { content_json?: string } | undefined;
  const patchContent = patch?.content_json ? JSON.parse(patch.content_json) as { files_changed?: string[] } : undefined;
  const filesChanged = patchContent?.files_changed || [];
  const repairChain = verifierTaskId !== 0 && Boolean(getTask(verifierTaskId)?.parent_task_id && getTask(getTask(verifierTaskId)!.parent_task_id!)?.role === "implementer");
  const events = listEventsForTask(task.job_id, taskId, 100) as { type: string }[];
  const hadContractViolation = events.some((event) => event.type === "contract_violation");
  return hadContractViolation || repairChain || filesChanged.length > 1;
}

export async function maybePersistReflection(taskId: number, verifierTaskId: number): Promise<void> {
  const task = getTask(taskId);
  const verifier = getTask(verifierTaskId);
  const job = task ? getJob(task.job_id) : undefined;
  if (!task || !verifier || !job) return;
  if (!shouldRunEpisodeReflection(taskId, verifierTaskId)) return;
  const settings = loadAppSettings();
  const provider = createProvider(task.assigned_model_provider, settings);
  const history = [
    ...(listEventsForTask(task.job_id, task.id, 25) as { type: string; message: string }[]).map((event) => ({
      role: event.type === "user_message" ? "user" : "system",
      content: `[${event.type}] ${event.message}`,
    })),
    ...(listEventsForTask(verifier.job_id, verifier.id, 25) as { type: string; message: string }[]).map((event) => ({
      role: "system",
      content: `[${event.type}] ${event.message}`,
    })),
  ];
  await runReflection({
    taskId: task.id,
    jobId: task.job_id,
    repoPath: job.repo_path,
    taskGoal: task.goal,
    taskRole: task.role,
    history,
    reasoning: "Episode verified successfully",
    provider,
    emit: (level, type, message, data) => {
      insertEvent({
        job_id: task.job_id,
        task_id: task.id,
        level,
        type,
        message,
        data_json: data != null ? JSON.stringify(data) : null,
      });
    },
  });
}
