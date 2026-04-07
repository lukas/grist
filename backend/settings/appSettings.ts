import { getAllSettings, getSetting, setSetting } from "../db/settingsRepo.js";
import type { ModelProviderName } from "../types/models.js";
import { envSettingsDefaults } from "./envMerge.js";

export interface AppSettings {
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
  /** Full command strings allowed for run_command_safe / run_tests */
  commandAllowlist?: string[];
  appWorkspaceRoot?: string;
}

const DEFAULT_ALLOWLIST = ["npm test", "pnpm test", "yarn test", "make test", "pytest", "go test ./..."];

function pick<T>(dbVal: T | undefined, envVal: T | undefined): T | undefined {
  if (envVal !== undefined && envVal !== null && envVal !== "") return envVal;
  if (dbVal !== undefined && dbVal !== null && dbVal !== "") return dbVal as T;
  return undefined;
}

export function loadAppSettings(): AppSettings {
  const all = getAllSettings();
  const env = envSettingsDefaults();
  return {
    anthropicApiKey: pick(all.anthropicApiKey as string | undefined, env.anthropicApiKey),
    openaiApiKey: pick(all.openaiApiKey as string | undefined, env.openaiApiKey),
    kimiBaseUrl: pick(all.kimiBaseUrl as string | undefined, env.kimiBaseUrl),
    kimiModel: pick(all.kimiModel as string | undefined, env.kimiModel),
    kimiApiKey: pick(all.kimiApiKey as string | undefined, env.kimiApiKey),
    claudeModel: pick(all.claudeModel as string | undefined, env.claudeModel),
    codexModel: pick(all.codexModel as string | undefined, env.codexModel),
    defaultProvider: pick(all.defaultProvider as ModelProviderName | undefined, env.defaultProvider),
    plannerProvider: pick(all.plannerProvider as ModelProviderName | undefined, env.plannerProvider),
    reducerProvider: pick(all.reducerProvider as ModelProviderName | undefined, env.reducerProvider),
    verifierProvider: pick(all.verifierProvider as ModelProviderName | undefined, env.verifierProvider),
    commandAllowlist:
      Array.isArray(all.commandAllowlist) && (all.commandAllowlist as string[]).length > 0
        ? (all.commandAllowlist as string[])
        : DEFAULT_ALLOWLIST,
    appWorkspaceRoot: pick(all.appWorkspaceRoot as string | undefined, undefined),
  };
}

export function saveAppSettingsPatch(patch: Partial<AppSettings>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) setSetting(k, v);
  }
}

export { getSetting, setSetting, getAllSettings };
