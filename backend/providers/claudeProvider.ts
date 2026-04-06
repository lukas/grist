import type { ModelProvider, ModelRequest, ModelResponse } from "../types/models.js";
import { extractJsonObject } from "./jsonExtract.js";

export class ClaudeProvider implements ModelProvider {
  name = "claude" as const;

  constructor(
    private apiKey: string,
    private model: string
  ) {}

  async generateText(input: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: input.modelName || this.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
      system: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt }],
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${raw.slice(0, 400)}`);
    const j = JSON.parse(raw) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string | null;
    };
    const text = j.content.map((c) => (c.type === "text" ? c.text || "" : "")).join("");
    const tokensIn = j.usage?.input_tokens ?? 0;
    const tokensOut = j.usage?.output_tokens ?? 0;
    return {
      text,
      raw,
      tokensIn,
      tokensOut,
      estimatedCost: (tokensIn * 3 + tokensOut * 15) / 1_000_000,
      finishReason: j.stop_reason || "stop",
    };
  }

  async generateStructured(input: ModelRequest): Promise<ModelResponse> {
    const prompt =
      input.userPrompt +
      "\n\nReturn a single JSON object matching the worker decision schema. No markdown fences.";
    const r = await this.generateText({ ...input, userPrompt: prompt });
    const parsed = extractJsonObject(r.text);
    return { ...r, parsedJson: parsed };
  }
}
