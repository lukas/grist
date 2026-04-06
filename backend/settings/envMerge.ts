import type { ModelProviderName } from "../types/models.js";

function envString(key: string): string | undefined {
  const v = process.env[key];
  return v != null && String(v).trim() !== "" ? String(v).trim() : undefined;
}

function envProvider(key: string): ModelProviderName | undefined {
  const v = envString(key)?.toLowerCase();
  if (v === "claude" || v === "codex" || v === "kimi" || v === "mock") return v;
  return undefined;
}

/** True if `.env` / environment configured a Kimi endpoint or key. */
export function envIndicatesKimi(): boolean {
  return Boolean(envString("GRIST_KIMI_BASE_URL") || envString("GRIST_KIMI_API_KEY"));
}

/**
 * Defaults from `process.env` (after dotenv). SQLite settings override when present.
 */
export function envSettingsDefaults(): {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  kimiBaseUrl?: string;
  kimiModel?: string;
  kimiApiKey?: string;
  claudeModel?: string;
  codexModel?: string;
  defaultProvider?: ModelProviderName;
  plannerProvider?: ModelProviderName;
  reducerProvider?: ModelProviderName;
  verifierProvider?: ModelProviderName;
} {
  const defaultProvider =
    envProvider("GRIST_DEFAULT_PROVIDER") ?? (envIndicatesKimi() ? ("kimi" as const) : undefined);

  return {
    anthropicApiKey: envString("GRIST_ANTHROPIC_API_KEY") ?? envString("ANTHROPIC_API_KEY"),
    openaiApiKey: envString("GRIST_OPENAI_API_KEY") ?? envString("OPENAI_API_KEY"),
    kimiBaseUrl: envString("GRIST_KIMI_BASE_URL"),
    kimiModel: envString("GRIST_KIMI_MODEL"),
    kimiApiKey: envString("GRIST_KIMI_API_KEY"),
    claudeModel: envString("GRIST_CLAUDE_MODEL"),
    codexModel: envString("GRIST_CODEX_MODEL"),
    defaultProvider,
    plannerProvider: envProvider("GRIST_PLANNER_PROVIDER"),
    reducerProvider: envProvider("GRIST_REDUCER_PROVIDER"),
    verifierProvider: envProvider("GRIST_VERIFIER_PROVIDER"),
  };
}
