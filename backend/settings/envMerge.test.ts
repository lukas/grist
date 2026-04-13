import { describe, it, expect, afterEach } from "vitest";
import { envIndicatesKimi, envSettingsDefaults } from "./envMerge.js";

describe("envMerge", () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it("envIndicatesKimi when base URL or key set", () => {
    delete process.env.GRIST_KIMI_BASE_URL;
    delete process.env.GRIST_KIMI_API_KEY;
    expect(envIndicatesKimi()).toBe(false);
    process.env.GRIST_KIMI_BASE_URL = "http://localhost:8000/v1";
    expect(envIndicatesKimi()).toBe(true);
  });

  it("defaults defaultProvider to kimi when Kimi configured", () => {
    process.env.GRIST_KIMI_BASE_URL = "http://host:8000/v1";
    process.env.GRIST_KIMI_API_KEY = "x";
    delete process.env.GRIST_DEFAULT_PROVIDER;
    const d = envSettingsDefaults();
    expect(d.defaultProvider).toBe("kimi");
  });

  it("GRIST_DEFAULT_PROVIDER=mock wins over Kimi env", () => {
    process.env.GRIST_KIMI_BASE_URL = "http://host:8000/v1";
    process.env.GRIST_DEFAULT_PROVIDER = "mock";
    expect(envSettingsDefaults().defaultProvider).toBe("mock");
  });

  it("prefers claude as planner when Anthropic key exists", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.GRIST_DEFAULT_PROVIDER = "kimi";
    expect(envSettingsDefaults().plannerProvider).toBe("claude");
  });

  it("respects explicit planner provider override", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.GRIST_PLANNER_PROVIDER = "kimi";
    expect(envSettingsDefaults().plannerProvider).toBe("kimi");
  });
});
