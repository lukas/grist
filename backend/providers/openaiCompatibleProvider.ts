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

  private async requestChatCompletion(body: Record<string, unknown>): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
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

  async generateText(input: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: input.modelName || this.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
    };
    if (this.name === "kimi" && input.jsonSchema) {
      body.response_format = { type: "json_object" };
    }
    try {
      return await this.requestChatCompletion(body);
    } catch (error) {
      if (!(this.name === "kimi" && input.jsonSchema && /HTTP 4\d\d:/i.test(String(error)))) {
        throw error;
      }
      delete body.response_format;
      return this.requestChatCompletion(body);
    }
  }

  async generateStructured(input: ModelRequest): Promise<ModelResponse> {
    const schemaHint = input.jsonSchema
      ? `Schema:\n${JSON.stringify(input.jsonSchema, null, 2)}`
      : "";
    const prompt = [
      input.userPrompt,
      "",
      "Return exactly one JSON object.",
      "Do not use markdown fences.",
      "Do not add prose before or after the JSON.",
      "Do not invent action names outside the schema.",
      schemaHint,
    ].filter(Boolean).join("\n");
    const r = await this.generateText({ ...input, userPrompt: prompt });
    const parsed = extractJsonObject(r.text);
    return { ...r, parsedJson: parsed };
  }
}
