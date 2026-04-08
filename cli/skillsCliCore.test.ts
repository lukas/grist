import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSkillsCli } from "./skillsCliCore.js";

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: ${name}
description: ${description}
---
# ${name}

${name} instructions.
`, "utf8");
}

describe("runSkillsCli", () => {
  const originalHome = process.env.GRIST_HOME;
  const originalBundled = process.env.GRIST_BUNDLED_SKILLS_DIR;
  const originalCwd = process.cwd();
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grist-skills-cli-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const bundled = join(root, "bundled");
    mkdirSync(bundled, { recursive: true });
    writeSkill(join(bundled, "frontend-debugger"), "frontend-debugger", "Helps with frontend issues.");
    process.env.GRIST_HOME = join(root, "home");
    process.env.GRIST_BUNDLED_SKILLS_DIR = bundled;
    process.chdir(repo);
  });

  afterEach(() => {
    process.env.GRIST_HOME = originalHome;
    process.env.GRIST_BUNDLED_SKILLS_DIR = originalBundled;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("prints available bundled skills", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSkillsCli(["available", "--repo", repo]);
    expect(code).toBe(0);
    expect(spy.mock.calls.flat().join("\n")).toContain("frontend-debugger");
  });

  it("installs and lists a project skill", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCli(["add", "frontend-debugger", "--scope", "project", "--repo", repo]);
    await runSkillsCli(["list", "--repo", repo]);
    const output = spy.mock.calls.flat().join("\n");
    expect(output).toContain("Installed frontend-debugger to project");
    expect(output).toContain("Global skills");
    expect(output).toContain("Project skills");
    expect(output).toContain("frontend-debugger");
  });

  it("shows the installed skill body", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCli(["add", "frontend-debugger", "--scope", "project", "--repo", repo]);
    await runSkillsCli(["show", "frontend-debugger", "--repo", repo]);
    expect(spy.mock.calls.flat().join("\n")).toContain("frontend-debugger instructions.");
  });
});
