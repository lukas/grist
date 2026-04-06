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
});
