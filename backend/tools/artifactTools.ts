import { insertArtifact } from "../db/artifactRepo.js";
import { listArtifactsForJob, listArtifactsForTasks } from "../db/artifactRepo.js";
import type { ToolContext, ToolResult } from "./toolTypes.js";

export function toolReadArtifacts(ctx: ToolContext, args: { taskIds?: number[] }): ToolResult {
  try {
    const rows =
      args.taskIds && args.taskIds.length > 0
        ? listArtifactsForTasks(ctx.jobId, args.taskIds)
        : listArtifactsForJob(ctx.jobId);
    return { ok: true, data: { artifacts: rows } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolWriteArtifact(
  ctx: ToolContext,
  args: { type: string; content: unknown; confidence?: number }
): ToolResult {
  try {
    const id = insertArtifact({
      job_id: ctx.jobId,
      task_id: ctx.taskId,
      type: args.type,
      content_json: JSON.stringify(args.content),
      confidence: args.confidence ?? 0.7,
    });
    return { ok: true, data: { artifactId: id } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
