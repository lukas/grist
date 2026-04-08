import { resolve } from "node:path";
import {
  getSkillCatalog,
  installSkill,
  listInstalledSkills,
  readInstalledSkill,
  removeSkill,
} from "../backend/skills/skillManager.js";
import type { SkillCatalogEntry, SkillInstallScope, SkillSummary } from "../backend/skills/skillTypes.js";

function flagVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function resolveScope(raw: string | undefined): SkillInstallScope | undefined {
  if (!raw) return undefined;
  if (raw === "global" || raw === "project") return raw;
  throw new Error(`Invalid scope: ${raw}`);
}

function resolveRepo(args: string[]): string {
  return resolve(flagVal(args, "--repo") || process.cwd());
}

function printInstalled(skills: SkillSummary[], label: string): void {
  console.log(`${label} (${skills.length})`);
  if (!skills.length) {
    console.log("  (none)");
    return;
  }
  for (const skill of skills) {
    console.log(`  - ${skill.id}: ${skill.description}`);
  }
}

function printAvailable(entries: SkillCatalogEntry[]): void {
  if (!entries.length) {
    console.log("No skills available.");
    return;
  }
  for (const entry of entries) {
    const installed = entry.installedScopes.length ? ` [installed: ${entry.installedScopes.join(", ")}]` : "";
    console.log(`- ${entry.id}: ${entry.description}${installed}`);
  }
}

function helpText(): string {
  return [
    "Skills CLI",
    "",
    "Usage: skills <command> [options]",
    "",
    "Commands:",
    "  available [--repo <path>]",
    "  list [--scope global|project] [--repo <path>]",
    "  add <skill-or-url> [--scope global|project] [--repo <path>]",
    "  remove <skillId> [--scope global|project] [--repo <path>]",
    "  show <skillId> [--scope global|project] [--repo <path>] [--file <name>]",
  ].join("\n");
}

export async function runSkillsCli(args: string[]): Promise<number> {
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return 0;
  }

  if (cmd === "available") {
    const repo = resolveRepo(args.slice(1));
    printAvailable(getSkillCatalog(repo).available);
    return 0;
  }

  if (cmd === "list") {
    const scope = resolveScope(flagVal(args.slice(1), "--scope"));
    const repo = resolveRepo(args.slice(1));
    const installed = listInstalledSkills(repo, scope || "all");
    if (!scope || scope === "global") printInstalled(installed.global, "Global skills");
    if (!scope || scope === "project") printInstalled(installed.project, "Project skills");
    return 0;
  }

  if (cmd === "add") {
    const skillOrUrl = args[1];
    if (!skillOrUrl) throw new Error("Usage: skills add <skill-or-url> [--scope global|project] [--repo <path>]");
    const scope = resolveScope(flagVal(args.slice(2), "--scope"));
    const repo = resolveRepo(args.slice(2));
    const installed = await installSkill({ skillOrUrl, scope, repoPath: repo });
    console.log(`Installed ${installed.id} to ${installed.scope}`);
    return 0;
  }

  if (cmd === "remove") {
    const skillId = args[1];
    if (!skillId) throw new Error("Usage: skills remove <skillId> [--scope global|project] [--repo <path>]");
    const scope = resolveScope(flagVal(args.slice(2), "--scope")) || "project";
    const repo = resolveRepo(args.slice(2));
    const removed = removeSkill(skillId, scope, repo);
    if (!removed) throw new Error(`Skill not found in ${scope} scope: ${skillId}`);
    console.log(`Removed ${skillId} from ${scope}`);
    return 0;
  }

  if (cmd === "show") {
    const skillId = args[1];
    if (!skillId) throw new Error("Usage: skills show <skillId> [--scope global|project] [--repo <path>] [--file <name>]");
    const scope = resolveScope(flagVal(args.slice(2), "--scope"));
    const repo = resolveRepo(args.slice(2));
    const file = flagVal(args.slice(2), "--file");
    const skill = readInstalledSkill(skillId, {
      repoPath: repo,
      scope: scope || "visible",
      file,
    });
    console.log(`# ${skill.id}`);
    console.log(`scope: ${skill.scope}`);
    console.log(`description: ${skill.description}`);
    if (skill.references.length) console.log(`references: ${skill.references.join(", ")}`);
    console.log("");
    console.log(skill.body);
    return 0;
  }

  throw new Error(`Unknown skills command: ${cmd}`);
}
