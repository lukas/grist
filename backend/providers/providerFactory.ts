import type { ModelProvider, ModelProviderName } from "../types/models.js";
import { ClaudeProvider } from "./claudeProvider.js";
import { MockProvider } from "./mockProvider.js";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import type { AppSettings } from "../settings/appSettings.js";

export function createProvider(name: ModelProviderName, settings: AppSettings): ModelProvider {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "claude": {
      const key = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
      if (!key) throw new Error("Claude selected but anthropicApiKey missing in settings / env");
      return new ClaudeProvider(key, settings.claudeModel || "claude-sonnet-4-20250514");
    }
    case "codex": {
      const key = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
      if (!key) throw new Error("Codex selected but openaiApiKey missing in settings / env");
      return new OpenAICompatibleProvider("codex", key, "https://api.openai.com/v1", settings.codexModel || "gpt-4.1");
    }
    case "kimi": {
      const base = settings.kimiBaseUrl || "http://127.0.0.1:11434/v1";
      const model = settings.kimiModel || "kimi";
      return new OpenAICompatibleProvider("kimi", settings.kimiApiKey || "", base, model);
    }
    default:
      return new MockProvider();
  }
}
