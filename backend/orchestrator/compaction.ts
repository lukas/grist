/**
 * Context compaction for long-running agent tasks.
 *
 * Two-phase approach based on industry best practices:
 * 1. Mechanical: trim tool results, drop reasoning, merge entries (free)
 * 2. LLM summary: generate a structured summary to replace history (1 LLM call)
 *
 * Triggered when cumulative tokens approach the task's max_tokens budget.
 */

import type { ModelProvider } from "../types/models.js";

export type HistoryEntry = { role: string; content: string };

const KEEP_RECENT = 6;

/**
 * Phase 1: Mechanical compaction — no LLM call needed.
 * Returns a new history array with reduced token footprint.
 * Preserves system_summary, subtask_result, and files_written entries.
 */
export function mechanicalCompact(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= KEEP_RECENT) return history;

  const recent = history.slice(-KEEP_RECENT);
  const older = history.slice(0, -KEEP_RECENT);

  // Extract files written from tool_result entries before compacting
  const filesWritten = new Set<string>();
  for (const entry of [...older, ...recent]) {
    if (entry.role === "tool_result") {
      const m = entry.content.match(/^(write_file|apply_patch): success.*?"path":\s*"([^"]+)"/);
      if (m) filesWritten.add(m[2]);
      const m2 = entry.content.match(/^write_file:.*?→.*?"path":\s*"([^"]+)"/);
      if (m2) filesWritten.add(m2[1]);
      // Also catch the compact format: "write_file: success — {"path":"foo.js"}"
      const m3 = entry.content.match(/write_file: success.*?"([^"]+\.(?:js|ts|py|json|md|html|css|jsx|tsx|yml|yaml|sh|rb|go|rs|c|cpp|h))"/);
      if (m3) filesWritten.add(m3[1]);
    }
  }

  const compacted: HistoryEntry[] = [];

  // Inject a durable "files written" entry that survives compaction
  if (filesWritten.size > 0) {
    compacted.push({
      role: "system_summary",
      content: `[Files written so far: ${[...filesWritten].join(", ")}]`,
    });
  }

  for (const entry of older) {
    if (entry.role === "reasoning") continue;

    // Always keep priority entries
    if (entry.role === "system_summary" || entry.role === "subtask_result") {
      compacted.push(entry);
      continue;
    }

    if (entry.role === "tool_result") {
      const colonIdx = entry.content.indexOf(":");
      const toolName = colonIdx > 0 ? entry.content.slice(0, colonIdx) : "tool";
      const rest = colonIdx > 0 ? entry.content.slice(colonIdx + 1).trim() : entry.content;

      if (rest.startsWith("success") || rest.startsWith("failed")) {
        compacted.push({ role: "tool_result", content: `${toolName}: ${rest.slice(0, 120)}` });
      } else {
        compacted.push({ role: "tool_result", content: `${toolName}: ${rest.slice(0, 200)}` });
      }
      continue;
    }

    if (entry.role === "assistant") {
      try {
        const parsed = JSON.parse(entry.content) as Record<string, unknown>;
        delete parsed.reasoning;
        compacted.push({ role: "assistant", content: JSON.stringify(parsed) });
      } catch {
        compacted.push({ role: "assistant", content: entry.content.slice(0, 300) });
      }
      continue;
    }

    compacted.push({ role: entry.role, content: entry.content.slice(0, 500) });
  }

  return [...compacted, ...recent];
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate total tokens of the history array.
 */
export function historyTokens(history: HistoryEntry[]): number {
  let total = 0;
  for (const e of history) {
    total += roughTokenCount(e.content) + 4; // overhead per entry
  }
  return total;
}

/**
 * Phase 2: LLM-powered summarization.
 * Asks the model to produce a structured summary of the work done so far.
 * Returns a single history entry that replaces everything before the recent entries.
 */
export async function llmCompact(
  history: HistoryEntry[],
  taskGoal: string,
  provider: ModelProvider,
): Promise<HistoryEntry[]> {
  if (history.length <= KEEP_RECENT) return history;

  const recent = history.slice(-KEEP_RECENT);
  const older = history.slice(0, -KEEP_RECENT);

  // Build a compact representation for the summarizer
  const olderText = older.map((e) => `[${e.role}] ${e.content.slice(0, 400)}`).join("\n");

  const summaryPrompt = `You are a context compactor for a coding agent. Summarize the conversation history below into a structured progress report. This summary will replace the full history in the agent's context window.

Task goal: ${taskGoal}

History to summarize (${older.length} entries):
${olderText.slice(0, 8000)}

Produce a concise summary in this format:
## Progress
- What has been accomplished so far (bullet points)

## Files Modified
- List of files created, modified, or read (with brief notes)

## Key Decisions
- Important choices made or patterns established

## Remaining Work
- What still needs to be done based on the goal

## Errors/Blockers
- Any errors encountered and how they were resolved (or still open)

Keep it under 500 words. Focus on actionable information the agent needs to continue working.`;

  try {
    const resp = await provider.generateText({
      systemPrompt: "You are a concise technical summarizer. Output only the summary, no preamble.",
      userPrompt: summaryPrompt,
      maxTokens: 2048,
      temperature: 0.1,
    });

    const summary: HistoryEntry = {
      role: "system_summary",
      content: `[Context compacted — ${older.length} entries summarized]\n${resp.text.slice(0, 3000)}`,
    };

    return [summary, ...recent];
  } catch {
    // If LLM summary fails, fall back to mechanical compaction
    return mechanicalCompact(history);
  }
}
