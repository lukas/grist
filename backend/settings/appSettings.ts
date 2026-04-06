import { getAllSettings, getSetting, setSetting } from "../db/settingsRepo.js";
import type { ModelProviderName } from "../types/models.js";

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

export function loadAppSettings(): AppSettings {
  const all = getAllSettings();
  return {
    anthropicApiKey: (all.anthropicApiKey as string) || undefined,
    openaiApiKey: (all.openaiApiKey as string) || undefined,
    kimiBaseUrl: (all.kimiBaseUrl as string) || undefined,
    kimiModel: (all.kimiModel as string) || undefined,
    kimiApiKey: (all.kimiApiKey as string) || undefined,
    claudeModel: (all.claudeModel as string) || undefined,
    codexModel: (all.codexModel as string) || undefined,
    defaultProvider: (all.defaultProvider as ModelProviderName) || undefined,
    plannerProvider: (all.plannerProvider as ModelProviderName) || undefined,
    reducerProvider: (all.reducerProvider as ModelProviderName) || undefined,
    verifierProvider: (all.verifierProvider as ModelProviderName) || undefined,
    commandAllowlist: (all.commandAllowlist as string[]) || DEFAULT_ALLOWLIST,
    appWorkspaceRoot: (all.appWorkspaceRoot as string) || undefined,
  };
}

export function saveAppSettingsPatch(patch: Partial<AppSettings>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) setSetting(k, v);
  }
}

export { getSetting, setSetting, getAllSettings };
