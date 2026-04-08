import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSkillIndex,
  getSkillCatalog,
  installSkill,
  listInstalledSkills,
  listVisibleSkills,
  readInstalledSkill,
} from "./skillManager.js";

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: ${name}
description: >-
  ${description}
---
# ${name}

${name} instructions.
`, "utf8");
}

describe("skillManager", () => {
  const originalHome = process.env.GRIST_HOME;
  const originalBundled = process.env.GRIST_BUNDLED_SKILLS_DIR;
  let root: string;
  let home: string;
  let repo: string;
  let bundled: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grist-skills-"));
    home = join(root, "home");
    repo = join(root, "repo");
    bundled = join(root, "bundled");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bundled, { recursive: true });
    writeSkill(join(bundled, "frontend-debugger"), "frontend-debugger", "Helps with renderer bugs.");
    writeSkill(join(bundled, "test-writer"), "test-writer", "Helps add focused tests.");
    process.env.GRIST_HOME = home;
    process.env.GRIST_BUNDLED_SKILLS_DIR = bundled;
  });

  afterEach(() => {
    process.env.GRIST_HOME = originalHome;
    process.env.GRIST_BUNDLED_SKILLS_DIR = originalBundled;
  });

  it("lists bundled skills as available before install", () => {
    const catalog = getSkillCatalog(repo);
    expect(catalog.available.map((skill) => skill.id)).toEqual(["frontend-debugger", "test-writer"]);
    expect(catalog.installedGlobal).toHaveLength(0);
    expect(catalog.installedProject).toHaveLength(0);
  });

  it("installs bundled skills into project and global scopes", async () => {
    await installSkill({ skillOrUrl: "frontend-debugger", scope: "project", repoPath: repo });
    const localSkillDir = join(repo, ".grist", "skills", "frontend-debugger");
    expect(readFileSync(join(localSkillDir, "SKILL.md"), "utf8")).toContain("frontend-debugger");

    const customSkillDir = join(root, "local-skill");
    writeSkill(customSkillDir, "test-writer", "Local override for tests.");
    await installSkill({ skillOrUrl: customSkillDir, scope: "global", repoPath: repo });

    const installed = listInstalledSkills(repo);
    expect(installed.project.map((skill) => skill.id)).toEqual(["frontend-debugger"]);
    expect(installed.global.map((skill) => skill.id)).toEqual(["test-writer"]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".grist");
  });

  it("builds a visible skill index with project precedence", async () => {
    const customSkillDir = join(root, "local-skill");
    writeSkill(customSkillDir, "frontend-debugger", "Project-local override.");
    await installSkill({ skillOrUrl: "frontend-debugger", scope: "global", repoPath: repo });
    await installSkill({ skillOrUrl: customSkillDir, scope: "project", repoPath: repo });

    const visible = listVisibleSkills(repo);
    expect(visible).toHaveLength(1);
    expect(visible[0].scope).toBe("project");
    expect(buildSkillIndex(repo)).toContain("frontend-debugger [project]");
  });

  it("reads installed skill contents", async () => {
    await installSkill({ skillOrUrl: "test-writer", scope: "project", repoPath: repo });
    const skill = readInstalledSkill("test-writer", { repoPath: repo });
    expect(skill.description).toContain("focused tests");
    expect(skill.body).toContain("instructions");
  });
});
