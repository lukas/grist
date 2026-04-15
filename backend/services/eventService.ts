import { insertEvent } from "../db/eventRepo.js";
import { updateTask } from "../db/taskRepo.js";

export interface DiscoveryEventEffect {
  annotateQueuedTaskIds?: number[];
  scratchpadNote?: string;
  requestReplan?: boolean;
}

export function processDiscoveryEvent(jobId: number, taskId: number, effect: DiscoveryEventEffect): void {
  if (effect.annotateQueuedTaskIds?.length) {
    for (const queuedTaskId of effect.annotateQueuedTaskIds) {
      updateTask(queuedTaskId, { next_action: "annotated_from_discovery" });
    }
  }
  if (effect.scratchpadNote) {
    insertEvent({
      job_id: jobId,
      task_id: taskId,
      level: "info",
      type: "discovery_note",
      message: effect.scratchpadNote.slice(0, 500),
    });
  }
  if (effect.requestReplan) {
    insertEvent({
      job_id: jobId,
      task_id: taskId,
      level: "warn",
      type: "replan_requested",
      message: "Discovery requested replan",
    });
  }
}
