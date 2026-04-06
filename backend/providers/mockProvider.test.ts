import { describe, it, expect } from "vitest";
import { MockProvider } from "./mockProvider.js";

describe("MockProvider", () => {
  it("returns call_tool list_files then read_file then grep then finish", async () => {
    const p = new MockProvider();
    const req = { systemPrompt: "s", userPrompt: "u", maxTokens: 100 };

    const r1 = await p.generateStructured(req);
    expect((r1.parsedJson as { decision: string; tool_name?: string }).decision).toBe("call_tool");
    expect((r1.parsedJson as { tool_name?: string }).tool_name).toBe("list_files");

    const r2 = await p.generateStructured(req);
    expect((r2.parsedJson as { tool_name?: string }).tool_name).toBe("read_file");

    const r3 = await p.generateStructured(req);
    expect((r3.parsedJson as { tool_name?: string }).tool_name).toBe("grep_code");

    const r4 = await p.generateStructured(req);
    expect((r4.parsedJson as { decision: string }).decision).toBe("finish");
    expect((r4.parsedJson as { artifact?: { type: string } }).artifact?.type).toBe("findings_report");
  });

  it("reset() restarts sequence", async () => {
    const p = new MockProvider();
    const req = { systemPrompt: "s", userPrompt: "u", maxTokens: 100 };
    await p.generateStructured(req);
    p.reset();
    const r = await p.generateStructured(req);
    expect((r.parsedJson as { tool_name?: string }).tool_name).toBe("list_files");
  });
});
