import { getTask, insertTask, updateTask, listTasksForJob } from "../db/taskRepo.js";
import { getJob } from "../db/jobRepo.js";
import type { ModelProviderName } from "../types/models.js";
import { insertEvent } from "../db/eventRepo.js";
import { getLatestArtifactForTask } from "../db/artifactRepo.js";
import { VerifierOutputSchema } from "../types/taskState.js";
import { scratchpadPath } from "../workspace/pathUtils.js";
import { ensureScratchpad } from "../workspace/scratchpadManager.js";
import { ALL_TOOL_NAMES } from "../tools/executeTool.js";

const PATCH_TOOLS = ALL_TOOL_NAMES.filter((n) => !["remove_worktree", "create_worktree"].includes(n));

export interface SpeculativeGroup {
  groupId: string;
  jobId: number;
  parentTaskId: number | null;
  candidateTaskIds: number[];
  winnerId: number | null;
}

const activeGroups = new Map<string, SpeculativeGroup>();

export function startSpeculativeGroup(
  jobId: number,
  baseGoal: string,
  approaches: string[],
  parentTaskId: number | null,
  appWorkspaceRoot: string,
  baseTask?: {
    scope_json: string;
    assigned_model_provider: string;
    allowed_tools_json: string;
    priority: number;
    max_steps: number;
    max_tokens: number;
    base_ref: string;
  },
): SpeculativeGroup {
  const groupId = `spec-${jobId}-${Date.now()}`;
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const candidateTaskIds: number[] = [];
  for (let i = 0; i < approaches.length; i++) {
    const approach = approaches[i];
    const taskId = insertTask({
      job_id: jobId,
      parent_task_id: parentTaskId,
      kind: "patch_writer",
      role: "implementer",
      goal: `${baseGoal}\n\nApproach: ${approach}`,
      scope_json: baseTask?.scope_json || JSON.stringify({ contract_json: { inputs: [], outputs: ["candidate_patch"], file_ownership: ["**/*"], acceptance_criteria: [], non_goals: [] } }),
      status: "queued",
      priority: (baseTask?.priority ?? 100) + 10 - i,
      assigned_model_provider: (baseTask?.assigned_model_provider || job.default_model_provider) as ModelProviderName,
      write_mode: "worktree",
      workspace_repo_mode: "isolated_worktree",
      scratchpad_path: "",
      worktree_path: null,
      git_branch: "",
      base_ref: baseTask?.base_ref || "",
      runtime_json: "{}",
      max_steps: baseTask?.max_steps ?? 32,
      max_tokens: baseTask?.max_tokens ?? 200_000,
      current_action: `speculative_candidate_${i + 1}`,
      next_action: "start",
      blocker: "",
      confidence: 0,
      files_examined_json: "[]",
      findings_json: "[]",
      open_questions_json: "[]",
      dependencies_json: "[]",
      allowed_tools_json: baseTask?.allowed_tools_json || JSON.stringify(PATCH_TOOLS),
      artifact_type: "candidate_patch",
    });
    const sp = scratchpadPath(appWorkspaceRoot, jobId, taskId);
    updateTask(taskId, { scratchpad_path: sp });
    ensureScratchpad(sp);
    candidateTaskIds.push(taskId);

    insertEvent({
      job_id: jobId,
      task_id: taskId,
      level: "info",
      type: "speculative_candidate",
      message: `Speculative candidate ${i + 1}/${approaches.length}: ${approach.slice(0, 100)}`,
      data_json: JSON.stringify({ groupId, candidateIndex: i, approach }),
    });
  }

  const group: SpeculativeGroup = {
    groupId,
    jobId,
    parentTaskId,
    candidateTaskIds,
    winnerId: null,
  };
  activeGroups.set(groupId, group);

  insertEvent({
    job_id: jobId,
    task_id: parentTaskId,
    level: "info",
    type: "speculative_group_started",
    message: `Started best-of-${approaches.length} speculative group`,
    data_json: JSON.stringify({ groupId, candidateTaskIds, approaches }),
  });

  return group;
}

export function checkSpeculativeGroupCompletion(taskId: number): {
  resolved: boolean;
  groupId: string | null;
  winnerId: number | null;
} {
  for (const [groupId, group] of activeGroups) {
    if (!group.candidateTaskIds.includes(taskId)) continue;
    if (group.winnerId != null) return { resolved: true, groupId, winnerId: group.winnerId };

    const tasks = group.candidateTaskIds.map((id) => getTask(id)).filter(Boolean);
    const allTerminal = tasks.every((t) => t && ["done", "failed", "stopped", "superseded"].includes(t.status));
    if (!allTerminal) return { resolved: false, groupId, winnerId: null };

    const allJobTasks = listTasksForJob(group.jobId);
    let bestId: number | null = null;
    let bestScore = -1;

    for (const candidateId of group.candidateTaskIds) {
      const candidate = getTask(candidateId);
      if (!candidate || candidate.status !== "done") continue;

      const verifier = allJobTasks.find(
        (t) => t.parent_task_id === candidateId && t.role === "verifier" && t.status === "done"
      );
      if (!verifier) {
        if (bestScore < 0.5) {
          bestScore = 0.5;
          bestId = candidateId;
        }
        continue;
      }

      const artifact = getLatestArtifactForTask(verifier.id, "verification_result") as { content_json: string } | undefined;
      if (!artifact) continue;
      try {
        const parsed = VerifierOutputSchema.parse(JSON.parse(artifact.content_json));
        const score = parsed.passed ? (1.0 + (parsed.confidence || 0)) : 0.1;
        if (score > bestScore) {
          bestScore = score;
          bestId = candidateId;
        }
      } catch {
        continue;
      }
    }

    if (bestId == null && tasks.length > 0) {
      const firstDone = tasks.find((t) => t && t.status === "done");
      if (firstDone) bestId = firstDone.id;
    }

    group.winnerId = bestId;

    for (const candidateId of group.candidateTaskIds) {
      if (candidateId !== bestId) {
        const t = getTask(candidateId);
        if (t && ["queued", "ready", "running", "blocked", "paused"].includes(t.status)) {
          updateTask(candidateId, { status: "superseded", blocker: `Lost speculative race to task ${bestId}` });
        }
      }
    }

    insertEvent({
      job_id: group.jobId,
      task_id: bestId,
      level: "info",
      type: "speculative_winner",
      message: `Task ${bestId} won speculative group (score ${bestScore.toFixed(2)})`,
      data_json: JSON.stringify({ groupId, winnerId: bestId, bestScore, candidates: group.candidateTaskIds }),
    });

    return { resolved: true, groupId, winnerId: bestId };
  }
  return { resolved: false, groupId: null, winnerId: null };
}

export function getActiveSpeculativeGroups(jobId: number): SpeculativeGroup[] {
  return [...activeGroups.values()].filter((g) => g.jobId === jobId);
}

export function isSpeculativeCandidate(taskId: number): boolean {
  for (const group of activeGroups.values()) {
    if (group.candidateTaskIds.includes(taskId)) return true;
  }
  return false;
}

export function cleanupSpeculativeGroups(jobId: number): void {
  for (const [id, group] of activeGroups) {
    if (group.jobId === jobId) activeGroups.delete(id);
  }
}
