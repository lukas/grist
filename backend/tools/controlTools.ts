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
