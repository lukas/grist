import type { ToolContext, ToolResult } from "./toolTypes.js";

export function toolEmitProgress(ctx: ToolContext, args: { message: string; data?: unknown }): ToolResult {
  ctx.emit("info", "progress", args.message, args.data);
  return { ok: true, data: { emitted: true } };
}

/** Worker checks decision pause_self; this tool is a no-op marker. */
export function toolPauseSelf(ctx: ToolContext, args: { reason?: string }): ToolResult {
  ctx.emit("warn", "pause_self", args.reason || "model requested pause");
  return { ok: true, data: { pause: true } };
}

/** Ask the operator a structured question and pause until they answer. */
export function toolAskUser(ctx: ToolContext, args: { question: string; options?: string[]; context?: string }): ToolResult {
  ctx.emit("info", "user_question", args.question, {
    question: args.question,
    options: args.options || [],
    context: args.context || "",
    taskId: ctx.taskId,
  });
  return { ok: true, data: { waiting: true, question: args.question } };
}
