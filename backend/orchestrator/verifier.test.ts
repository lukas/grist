import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __verifierInternals } from "./verifier.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifier command planning", () => {
  it("falls back to build and smoke checks when tests are absent", () => {
    const dir = makeTempDir("grist-verifier-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "backgammon-cli",
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
      },
    }, null, 2));

    const commands = __verifierInternals.chooseVerificationCommands(dir);

    expect(commands.map((command) => command.name)).toEqual(["build_execution", "startup_smoke"]);
    expect(commands[0]?.command).toBe("npm run build");
    expect(commands[1]?.command).toBe("npm start");
  });

  it("prefers test execution when a test script exists", () => {
    const dir = makeTempDir("grist-verifier-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "app",
      scripts: {
        test: "vitest run",
        build: "vite build",
      },
    }, null, 2));

    const commands = __verifierInternals.chooseVerificationCommands(dir);

    expect(commands.map((command) => command.name)).toEqual(["test_execution", "build_execution"]);
  });
});

describe("verifier policy overrides", () => {
  it("treats interactive startup timeouts with visible output as healthy smoke checks", () => {
    expect(__verifierInternals.isHealthyStartupTimeout({
      ok: true,
      data: {
        code: 124,
        stdout: "Backgammon CLI started\nWaiting for input...\n",
        stderr: "",
      },
    })).toBe(true);
  });

  it("does not fail solely because npm test is missing when build/smoke checks passed", () => {
    const parsed = {
      passed: false,
      checks: [],
      tests_run: ["npm run build", "npm start"],
      failures: ["npm error Missing script: \"test\""],
      failing_logs_summary: "npm error Missing script: \"test\"",
      likely_root_cause: "package.json does not define a test script",
      summary: "Build verification failed because no test script is configured.",
      confidence: 0.8,
      recommended_next_action: "Add tests",
    };
    const adjusted = __verifierInternals.applyVerificationPolicy(parsed, [
      {
        name: "build_execution",
        command: "npm run build",
        status: "passed",
        details: "Command exited successfully.",
        result: { ok: true, data: { code: 0, stdout: "", stderr: "" } },
      },
      {
        name: "startup_smoke",
        command: "npm start",
        status: "passed",
        details: "Interactive startup produced output and then hit the smoke-test timeout.",
        result: { ok: true, data: { code: 124, stdout: "Ready", stderr: "" } },
      },
    ]);

    expect(adjusted.passed).toBe(true);
    expect(adjusted.failures).toEqual([]);
    expect(adjusted.recommended_next_action).toContain("Wrap up");
  });
});
