import type { ModelProvider, ModelRequest, ModelResponse } from "../types/models.js";
import { extractJsonObject } from "./jsonExtract.js";

type Name = "codex" | "kimi";

/** OpenAI-compatible chat completions (Codex / local Kimi). */
export class OpenAICompatibleProvider implements ModelProvider {
  name: Name;
  constructor(
    name: Name,
    private apiKey: string,
    private baseUrl: string,
    private model: string
  ) {
    this.name = name;
  }

  async generateText(input: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: input.modelName || this.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}: ${raw.slice(0, 400)}`);
    const j = JSON.parse(raw) as {
      choices: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = j.choices[0]?.message;
    const text = msg?.content || msg?.reasoning_content || "";
    const tokensIn = j.usage?.prompt_tokens ?? 0;
    const tokensOut = j.usage?.completion_tokens ?? 0;
    return {
      text,
      raw,
      tokensIn,
      tokensOut,
      estimatedCost: (tokensIn + tokensOut) / 1_000_000,
      finishReason: j.choices[0]?.finish_reason || "stop",
    };
  }

  async generateStructured(input: ModelRequest): Promise<ModelResponse> {
    const prompt =
      input.userPrompt + "\n\nReturn a single JSON object matching the schema. No markdown fences.";
    const r = await this.generateText({ ...input, userPrompt: prompt });
    const parsed = extractJsonObject(r.text);
    return { ...r, parsedJson: parsed };
  }
}
