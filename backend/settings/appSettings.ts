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
  /** Parallelism urgency: "low" | "normal" | "high" | "max" */
  urgency?: string;
}

const DEFAULT_ALLOWLIST = [
  "npm test", "pnpm test", "yarn test", "make test", "pytest", "go test",
  "npm run", "npm start", "npx", "pnpm run", "yarn run",
  "node", "python", "python3",
  "make", "cargo run", "cargo build", "go run", "go build",
  "open", "cat", "ls", "head", "tail", "wc", "find", "which", "pwd", "echo", "printf",
  "git status", "git diff", "git log", "git show", "git branch", "git add", "git commit", "git push", "git remote", "git rev-parse",
  "gh --version", "gh auth status", "gh repo view", "gh pr create", "gh pr view",
  "curl", "wget",
  "timeout", "env", "xargs", "sort", "uniq", "grep", "awk", "sed",
  "tsc", "eslint", "prettier", "rustfmt", "cargo fmt", "cargo clippy",
  "pip install", "npm install", "pnpm install", "yarn install",
  "npm init -y", "yarn init -y", "pnpm init",
];

function pick<T>(dbVal: T | undefined, envVal: T | undefined): T | undefined {
  if (dbVal !== undefined && dbVal !== null && dbVal !== "") return dbVal as T;
  if (envVal !== undefined && envVal !== null && envVal !== "") return envVal;
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
    urgency: pick(all.urgency as string | undefined, undefined),
  };
}

export function saveAppSettingsPatch(patch: Partial<AppSettings>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) setSetting(k, v);
  }
}

export { getSetting, setSetting, getAllSettings };
