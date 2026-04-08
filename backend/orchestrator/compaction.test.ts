import { describe, it, expect } from "vitest";
import { mechanicalCompact, historyTokens, type HistoryEntry } from "./compaction.js";

function makeHistory(n: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) {
      entries.push({ role: "assistant", content: JSON.stringify({ decision: "call_tool", reasoning: "x".repeat(200), tool_name: `tool_${i}` }) });
    } else if (i % 3 === 1) {
      entries.push({ role: "tool_result", content: `read_file: ${"x".repeat(2000)}` });
    } else {
      entries.push({ role: "reasoning", content: "y".repeat(500) });
    }
  }
  return entries;
}

describe("mechanicalCompact", () => {
  it("preserves short history unchanged", () => {
    const h: HistoryEntry[] = [
      { role: "assistant", content: "hi" },
      { role: "tool_result", content: "ok" },
    ];
    expect(mechanicalCompact(h)).toEqual(h);
  });

  it("drops reasoning entries from older history", () => {
    const h = makeHistory(18);
    const result = mechanicalCompact(h);
    // Compacted older portion should have no reasoning entries
    const olderPortion = result.slice(0, -6);
    const olderReasoning = olderPortion.filter((e) => e.role === "reasoning");
    expect(olderReasoning.length).toBe(0);
  });

  it("reduces total token count significantly", () => {
    const h = makeHistory(30);
    const before = historyTokens(h);
    const after = historyTokens(mechanicalCompact(h));
    expect(after).toBeLessThan(before * 0.6);
  });

  it("always keeps the last 6 entries intact", () => {
    const h = makeHistory(20);
    const lastSix = h.slice(-6);
    const result = mechanicalCompact(h);
    expect(result.slice(-6)).toEqual(lastSix);
  });
});

describe("historyTokens", () => {
  it("estimates tokens for entries", () => {
    const h: HistoryEntry[] = [{ role: "assistant", content: "hello world" }];
    const tokens = historyTokens(h);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});
