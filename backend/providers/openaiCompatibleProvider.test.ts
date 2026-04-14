import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";

const originalFetch = globalThis.fetch;

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests json mode for kimi structured output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "{\"decision\":\"pause_self\"}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenAICompatibleProvider("kimi", "", "http://localhost:8000/v1", "moonshotai/Kimi-K2.5");
    await provider.generateStructured({
      systemPrompt: "s",
      userPrompt: "u",
      jsonSchema: { type: "object" },
      maxTokens: 100,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { response_format?: { type: string } };
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
