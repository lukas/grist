import { appendScratchpad, readScratchpad, writeScratchpad } from "../workspace/scratchpadManager.js";
import type { ToolContext, ToolResult } from "./toolTypes.js";

export function toolReadScratchpad(ctx: ToolContext): ToolResult {
  try {
    return { ok: true, data: { content: readScratchpad(ctx.scratchpadPath) } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolWriteScratchpad(ctx: ToolContext, args: { content: string }): ToolResult {
  try {
    writeScratchpad(ctx.scratchpadPath, args.content);
    return { ok: true, data: { written: true } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolAppendScratchpad(ctx: ToolContext, args: { content: string }): ToolResult {
  try {
    appendScratchpad(ctx.scratchpadPath, args.content);
    return { ok: true, data: { appended: true } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
