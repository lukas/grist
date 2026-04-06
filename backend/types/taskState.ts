import { z } from "zod";

/** Spec §9 structured worker decision (one tool per iteration). */
export const WorkerDecisionSchema = z.object({
  decision: z.enum(["call_tool", "finish", "pause_self"]),
  reasoning_summary: z.string().optional().default(""),
  expected_information_gain: z.number().optional(),
  tool_name: z.string().optional(),
  tool_args: z.record(z.unknown()).optional(),
  artifact: z
    .object({
      type: z.string(),
      content: z.unknown(),
    })
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
  overall_confidence: z.number().optional().default(0),
  summary_text: z.string().optional().default(""),
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
  tests_run: z.array(z.string()).optional().default([]),
  failures: z.array(z.string()).optional().default([]),
  summary: z.string().optional().default(""),
  confidence: z.number().optional().default(0),
  recommended_next_action: z.string().optional().default(""),
});

export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;
