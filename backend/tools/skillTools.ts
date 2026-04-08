import type { ToolContext, ToolResult } from "./toolTypes.js";
import { getSkillCatalog, listVisibleSkills, readInstalledSkill } from "../skills/skillManager.js";

export function toolListSkills(
  ctx: ToolContext,
  args: { scope?: "visible" | "global" | "project" | "all" } = {},
): ToolResult {
  const scope = args.scope || "visible";

  if (scope === "visible") {
    const skills = listVisibleSkills(ctx.repoPath).map((skill) => ({
      id: skill.id,
      scope: skill.scope,
      description: skill.description,
      references: skill.references,
    }));
    return { ok: true, data: { skills } };
  }

  const catalog = getSkillCatalog(ctx.repoPath);
  return {
    ok: true,
    data: {
      available: catalog.available,
      installedGlobal: scope === "project" ? [] : catalog.installedGlobal.map((skill) => ({
        id: skill.id,
        scope: skill.scope,
        description: skill.description,
        references: skill.references,
      })),
      installedProject: scope === "global" ? [] : catalog.installedProject.map((skill) => ({
        id: skill.id,
        scope: skill.scope,
        description: skill.description,
        references: skill.references,
      })),
    },
  };
}

export function toolReadSkill(
  ctx: ToolContext,
  args: { skillId: string; scope?: "global" | "project"; file?: string },
): ToolResult {
  if (!args.skillId) return { ok: false, error: "skillId is required" };

  try {
    const skill = readInstalledSkill(args.skillId, {
      repoPath: ctx.repoPath,
      scope: args.scope || "visible",
      file: args.file,
    });
    return {
      ok: true,
      data: {
        id: skill.id,
        scope: skill.scope,
        description: skill.description,
        references: skill.references,
        content: skill.body,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
