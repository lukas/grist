import { z } from "zod";
import { ARTIFACT_TYPES, WORKER_ROLES } from "./models.js";

const WorkerRoleSchema = z.enum(WORKER_ROLES);
const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);

export const WorkerPacketSchema = z.object({
  files: z.array(z.string()).optional().default([]),
  area: z.string().optional().default(""),
  workflow_phase: z.string().optional().default(""),
  acceptance_criteria: z.array(z.string()).optional().default([]),
  non_goals: z.array(z.string()).optional().default([]),
  similar_patterns: z.array(z.string()).optional().default([]),
  constraints: z.array(z.string()).optional().default([]),
  commands_allowed: z.array(z.string()).optional().default([]),
  success_criteria: z.array(z.string()).optional().default([]),
});

export type WorkerPacket = z.infer<typeof WorkerPacketSchema>;

export const PlannedWorkerTaskSchema = z.object({
  role: WorkerRoleSchema,
  goal: z.string().min(1),
  packet: WorkerPacketSchema.optional().default({}),
  max_steps: z.number().int().positive().optional().default(20),
  depends_on: z.array(z.number().int().nonnegative()).optional().default([]),
});

export type PlannedWorkerTask = z.infer<typeof PlannedWorkerTaskSchema>;

export const ManagerPlanSchema = z.object({
  reasoning: z.string().min(1),
  accepted_assumptions: z.array(z.string()).optional().default([]),
  parallelism_notes: z.array(z.string()).optional().default([]),
  tasks: z.array(PlannedWorkerTaskSchema).min(1),
});

export type ManagerPlan = z.infer<typeof ManagerPlanSchema>;

const ToolCallSchema = z.object({
  tool_name: z.string(),
  tool_args: z.record(z.unknown()).optional().default({}),
});

export const ScoutArtifactContentSchema = z.object({
  relevant_files: z.array(z.string()).optional().default([]),
  analogous_patterns: z.array(z.string()).optional().default([]),
  commands_to_run: z.array(z.string()).optional().default([]),
  ambiguity_notes: z.array(z.string()).optional().default([]),
});

export type ScoutArtifactContent = z.infer<typeof ScoutArtifactContentSchema>;

export const ImplementerArtifactContentSchema = z.object({
  diff_summary: z.string().optional().default(""),
  files_changed: z.array(z.string()).optional().default([]),
  tests_added: z.array(z.string()).optional().default([]),
  migration_notes: z.array(z.string()).optional().default([]),
});

export type ImplementerArtifactContent = z.infer<typeof ImplementerArtifactContentSchema>;

export const ReviewerArtifactContentSchema = z.object({
  findings: z.array(z.string()).optional().default([]),
  risk_flags: z.array(z.string()).optional().default([]),
  api_consistency_notes: z.array(z.string()).optional().default([]),
});

export type ReviewerArtifactContent = z.infer<typeof ReviewerArtifactContentSchema>;

export const WorkerDecisionSchema = z.object({
  decision: z.enum(["call_tool", "call_tools", "finish", "pause_self"]),
  reasoning_summary: z.string().optional().default(""),
  expected_information_gain: z.number().optional(),
  // Single tool call (call_tool)
  tool_name: z.string().optional(),
  tool_args: z.record(z.unknown()).optional(),
  // Parallel tool calls (call_tools)
  tool_calls: z.array(ToolCallSchema).optional(),
  artifact: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("findings_report"),
        content: ScoutArtifactContentSchema,
      }),
      z.object({
        type: z.literal("candidate_patch"),
        content: ImplementerArtifactContentSchema,
      }),
      z.object({
        type: z.literal("review_report"),
        content: ReviewerArtifactContentSchema,
      }),
      z.object({
        type: z.literal("verification_result"),
        content: z.unknown(),
      }),
      z.object({
        type: z.literal("final_summary"),
        content: z.unknown(),
      }),
      z.object({
        type: z.literal("manager_plan"),
        content: ManagerPlanSchema,
      }),
      z.object({
        type: z.literal("reducer_summary"),
        content: z.unknown(),
      }),
      z.object({
        type: z.literal("hypothesis_list"),
        content: z.unknown(),
      }),
      z.object({
        type: z.literal("file_map"),
        content: z.unknown(),
      }),
    ])
    .optional(),
  task_state_update: z
    .object({
      current_action: z.string().optional(),
      next_action: z.string().optional(),
      confidence: z.number().optional(),
      new_findings: z.array(z.unknown()).optional(),
      new_open_questions: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export type WorkerDecision = z.infer<typeof WorkerDecisionSchema>;

export const ReducerOutputSchema = z.object({
  confirmed_facts: z.array(z.string()).optional().default([]),
  top_hypotheses: z.array(z.string()).optional().default([]),
  contradictions: z.array(z.string()).optional().default([]),
  recommended_next_tasks: z.array(z.string()).optional().default([]),
  open_questions: z.array(z.string()).optional().default([]),
  handoff_notes: z.array(z.string()).optional().default([]),
  overall_confidence: z.number().optional().default(0),
  summary_text: z.string().optional().default(""),
  final_summary: z.string().optional().default(""),
  recommendation: z.enum([
    "no_more_work",
    "spawn_patch",
    "verification_required",
    "replan_required",
  ]).optional().default("no_more_work"),
});

export type ReducerOutput = z.infer<typeof ReducerOutputSchema>;

export const VerifierOutputSchema = z.object({
  passed: z.boolean().optional().default(false),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["passed", "failed", "skipped"]),
    details: z.string().optional().default(""),
  })).optional().default([]),
  tests_run: z.array(z.string()).optional().default([]),
  failures: z.array(z.string()).optional().default([]),
  failing_logs_summary: z.string().optional().default(""),
  likely_root_cause: z.string().optional().default(""),
  summary: z.string().optional().default(""),
  confidence: z.number().optional().default(0),
  recommended_next_action: z.string().optional().default(""),
});

export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export function expectedArtifactTypeForRole(role: z.infer<typeof WorkerRoleSchema>): z.infer<typeof ArtifactTypeSchema> {
  switch (role) {
    case "scout":
      return "findings_report";
    case "implementer":
      return "candidate_patch";
    case "reviewer":
      return "review_report";
    case "verifier":
      return "verification_result";
    case "summarizer":
      return "final_summary";
  }
}

export function defaultArtifactContentForRole(role: z.infer<typeof WorkerRoleSchema>, reasoningSummary: string): unknown {
  switch (role) {
    case "scout":
      return ScoutArtifactContentSchema.parse({
        ambiguity_notes: reasoningSummary ? [reasoningSummary] : [],
      });
    case "implementer":
      return ImplementerArtifactContentSchema.parse({
        diff_summary: reasoningSummary,
      });
    case "reviewer":
      return ReviewerArtifactContentSchema.parse({
        findings: reasoningSummary ? [reasoningSummary] : [],
      });
    case "verifier":
      return VerifierOutputSchema.parse({
        summary: reasoningSummary,
      });
    case "summarizer":
      return ReducerOutputSchema.parse({
        final_summary: reasoningSummary,
        summary_text: reasoningSummary,
      });
  }
}
