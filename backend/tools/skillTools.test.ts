import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "./toolTypes.js";
import { installSkill } from "../skills/skillManager.js";
import { toolListSkills, toolReadSkill } from "./skillTools.js";

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

function ctx(repo: string): ToolContext {
  return {
    jobId: 1,
    taskId: 1,
    repoPath: repo,
    worktreePath: null,
    scratchpadPath: join(repo, "scratch.md"),
    appWorkspaceRoot: join(repo, ".grist-work"),
    allowedToolNames: ["list_skills", "read_skill"],
    commandAllowlist: [],
    emit: () => {},
  };
}

describe("skillTools", () => {
  const originalHome = process.env.GRIST_HOME;
  const originalBundled = process.env.GRIST_BUNDLED_SKILLS_DIR;
  let root: string;
  let repo: string;
  let bundled: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "grist-skill-tools-"));
    repo = join(root, "repo");
    bundled = join(root, "bundled");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bundled, { recursive: true });
    writeFileSync(join(repo, "scratch.md"), "", "utf8");
    writeSkill(join(bundled, "repo-archaeologist"), "repo-archaeologist", "Explore repo structure.");
    process.env.GRIST_HOME = join(root, "home");
    process.env.GRIST_BUNDLED_SKILLS_DIR = bundled;
    await installSkill({ skillOrUrl: "repo-archaeologist", scope: "project", repoPath: repo });
  });

  afterEach(() => {
    process.env.GRIST_HOME = originalHome;
    process.env.GRIST_BUNDLED_SKILLS_DIR = originalBundled;
  });

  it("lists visible skills for the repo", () => {
    const result = toolListSkills(ctx(repo));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { skills: { id: string }[] }).skills[0].id).toBe("repo-archaeologist");
    }
  });

  it("reads the installed skill body", () => {
    const result = toolReadSkill(ctx(repo), { skillId: "repo-archaeologist" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { content: string }).content).toContain("instructions");
    }
  });
});
