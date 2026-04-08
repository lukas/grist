import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __modelsDir = dirname(fileURLToPath(import.meta.url));

export interface ModelEntry {
  id: string;
  label: string;
  maxOutput?: number;
}

export interface ProviderConfig {
  id: string;
  label: string;
  type: "anthropic" | "openai" | "openai-compatible" | "mock";
  models: ModelEntry[];
  defaultModel: string;
  temperature: number;
  envKeyPrefix?: string;
}

export interface ModelsConfig {
  providers: ProviderConfig[];
}

let cached: ModelsConfig | null = null;

function findConfigPath(): string | null {
  const candidates = [
    join(__modelsDir, "..", "models.config.json"),
    join(__modelsDir, "..", "..", "models.config.json"),
    join(process.cwd(), "models.config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadModelsConfig(): ModelsConfig {
  if (cached) return cached;
  const path = findConfigPath();
  if (path) {
    try {
      const raw = readFileSync(path, "utf-8");
      cached = JSON.parse(raw) as ModelsConfig;
      return cached;
    } catch {
      /* fall through to defaults */
    }
  }
  cached = {
    providers: [
      {
        id: "claude", label: "Claude", type: "anthropic",
        models: [{ id: "claude-sonnet-4-20250514", label: "Sonnet 4" }],
        defaultModel: "claude-sonnet-4-20250514", temperature: 0.2,
      },
      {
        id: "codex", label: "OpenAI", type: "openai",
        models: [{ id: "gpt-4.1", label: "GPT-4.1" }],
        defaultModel: "gpt-4.1", temperature: 0.2,
      },
      {
        id: "kimi", label: "Kimi", type: "openai-compatible",
        models: [{ id: "moonshotai/Kimi-K2.5", label: "Kimi K2.5" }],
        defaultModel: "moonshotai/Kimi-K2.5", temperature: 0.6,
      },
      {
        id: "mock", label: "Mock", type: "mock",
        models: [{ id: "mock", label: "Mock" }],
        defaultModel: "mock", temperature: 0,
      },
    ],
  };
  return cached;
}

export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return loadModelsConfig().providers.find((p) => p.id === providerId);
}
