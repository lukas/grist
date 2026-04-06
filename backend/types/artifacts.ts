import type { ArtifactType } from "./models.js";

export interface ArtifactRow {
  id: number;
  job_id: number;
  task_id: number | null;
  type: ArtifactType | string;
  subtype: string | null;
  content_json: string;
  confidence: number;
  created_at: string;
}
