export const MAX_REPAIR_ATTEMPTS = 2;
export const REPAIR_REPLAN_THRESHOLD = 0.6;
export const JOB_REPLAN_THRESHOLD = 0.8;
export const MAX_REPLANS_PER_JOB = 2;
export const MAX_INTEGRATION_REPLANS = 1;

export interface ReplanContext {
  repairAttempts: number;
  majorContractViolation: boolean;
  integrationFailure: boolean;
  budgetExhausted: boolean;
  dependencyMismatch: boolean;
  existingReplans: number;
}

export function shouldReplan(context: ReplanContext): boolean {
  if (context.existingReplans >= MAX_REPLANS_PER_JOB) return false;
  if (context.majorContractViolation) return true;
  if (context.dependencyMismatch) return true;
  if (context.integrationFailure) return true;
  if (context.budgetExhausted && context.repairAttempts / Math.max(MAX_REPAIR_ATTEMPTS, 1) >= REPAIR_REPLAN_THRESHOLD) return true;
  if (context.repairAttempts >= MAX_REPAIR_ATTEMPTS) return true;
  return false;
}
