import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureGristDir } from "../logging/taskLogger.js";
import type {
  SkillCatalogEntry,
  SkillCatalogView,
  SkillFrontmatter,
  SkillInstallMetadata,
  SkillInstallScope,
  SkillInstallSource,
  SkillScope,
  SkillSummary,
} from "./skillTypes.js";

const INSTALL_META_FILE = ".grist-skill.json";
const SKILL_FILE = "SKILL.md";

function nowIso(): string {
  return new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(raw: string): unknown {
  const value = stripQuotes(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function countIndent(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function parseYamlBlock(lines: string[], startIndex = 0, baseIndent = 0): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const rawLine = lines[i];
    if (!rawLine.trim()) {
      i += 1;
      continue;
    }

    const indent = countIndent(rawLine);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      i += 1;
      continue;
    }

    const line = rawLine.slice(baseIndent);
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1];
    const rest = match[2] ?? "";

    if (rest === ">-" || rest === "|" || rest === ">") {
      const block: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) {
          block.push("");
          i += 1;
          continue;
        }
        const nextIndent = countIndent(next);
        if (nextIndent <= baseIndent) break;
        block.push(next.slice(baseIndent + 2));
        i += 1;
      }
      out[key] = rest === "|" ? block.join("\n").trim() : block.join("\n").replace(/\n+/g, " ").trim();
      continue;
    }

    if (!rest) {
      const nextIndex = i + 1;
      if (nextIndex < lines.length && countIndent(lines[nextIndex]) > baseIndent) {
        const [nested, endIndex] = parseYamlBlock(lines, nextIndex, baseIndent + 2);
        out[key] = nested;
        i = endIndex;
        continue;
      }
      out[key] = "";
      i += 1;
      continue;
    }

    out[key] = parseScalar(rest);
    i += 1;
  }

  return [out, i];
}

function splitSkillMarkdown(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");

  const [frontmatter] = parseYamlBlock(match[1].split(/\r?\n/));
  const name = String(frontmatter.name ?? "").trim();
  const description = String(frontmatter.description ?? "").trim();

  if (!name) throw new Error("Skill frontmatter requires `name`");
  if (!description) throw new Error("Skill frontmatter requires `description`");

  return {
    frontmatter: {
      ...frontmatter,
      name,
      description,
      metadata: isObject(frontmatter.metadata) ? frontmatter.metadata : undefined,
    } as SkillFrontmatter,
    body: match[2].trim(),
  };
}

function sanitizeSkillId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function ensureValidSkillId(id: string): string {
  const clean = sanitizeSkillId(id);
  if (!clean) throw new Error("Skill id must contain letters or numbers");
  return clean;
}

function readInstallMetadata(dirPath: string): SkillInstallMetadata | undefined {
  const metaPath = join(dirPath, INSTALL_META_FILE);
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as SkillInstallMetadata;
  } catch {
    return undefined;
  }
}

function writeInstallMetadata(dirPath: string, metadata: SkillInstallMetadata): void {
  writeFileSync(join(dirPath, INSTALL_META_FILE), JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

function listReferences(dirPath: string): string[] {
  const refDir = join(dirPath, "references");
  if (!existsSync(refDir)) return [];
  return readdirSync(refDir)
    .filter((name) => statSync(join(refDir, name)).isFile())
    .sort();
}

function readSkillDirectory(dirPath: string, scope: SkillScope): SkillSummary | null {
  const skillPath = join(dirPath, SKILL_FILE);
  if (!existsSync(skillPath)) return null;
  const { frontmatter, body } = splitSkillMarkdown(readFileSync(skillPath, "utf8"));
  const id = ensureValidSkillId(frontmatter.name || basename(dirPath));
  return {
    id,
    name: String(frontmatter.name),
    description: String(frontmatter.description),
    scope,
    dirPath,
    skillPath,
    references: listReferences(dirPath),
    body,
    frontmatter,
    installMetadata: scope === "bundled" ? undefined : readInstallMetadata(dirPath),
  };
}

function readSkillDirs(root: string, scope: SkillScope): SkillSummary[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((full) => existsSync(full) && statSync(full).isDirectory())
    .map((dirPath) => readSkillDirectory(dirPath, scope))
    .filter((skill): skill is SkillSummary => skill !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function detectInstallSource(skillOrUrl: string): SkillInstallSource {
  if (/^https?:\/\//i.test(skillOrUrl)) return { kind: "url", value: skillOrUrl };
  const maybePath = resolve(skillOrUrl);
  if (existsSync(maybePath)) return { kind: "local", value: maybePath };
  return { kind: "bundled", value: ensureValidSkillId(skillOrUrl) };
}

function readLocalSkillSource(pathOrFile: string): { markdown: string; copyFromDir?: string } {
  const full = resolve(pathOrFile);
  const st = statSync(full);
  if (st.isDirectory()) {
    const skillPath = join(full, SKILL_FILE);
    if (!existsSync(skillPath)) throw new Error(`Directory is missing ${SKILL_FILE}`);
    return { markdown: readFileSync(skillPath, "utf8"), copyFromDir: full };
  }
  return { markdown: readFileSync(full, "utf8") };
}

async function readRemoteSkillSource(url: string): Promise<{ markdown: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch skill from ${url}: ${response.status}`);
  }
  return { markdown: await response.text() };
}

function prepareDestRoot(scope: SkillInstallScope, repoPath?: string): string {
  if (scope === "project") {
    if (!repoPath) throw new Error("Project scope requires a repo path");
    ensureGristDir(repoPath);
    const root = join(repoPath, ".grist", "skills");
    mkdirSync(root, { recursive: true });
    return root;
  }
  const root = join(getGristHomeDir(), "skills");
  mkdirSync(root, { recursive: true });
  return root;
}

function writeSkillFiles(destDir: string, markdown: string, copyFromDir?: string): void {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (copyFromDir) {
    cpSync(copyFromDir, destDir, { recursive: true });
  } else {
    writeFileSync(join(destDir, SKILL_FILE), markdown, "utf8");
  }
}

export function getGristHomeDir(): string {
  return resolve(process.env.GRIST_HOME || join(homedir(), ".grist"));
}

export function getGlobalSkillsRoot(): string {
  return join(getGristHomeDir(), "skills");
}

export function getProjectSkillsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".grist", "skills");
}

export function getBundledSkillsRoot(): string {
  if (process.env.GRIST_BUNDLED_SKILLS_DIR) return resolve(process.env.GRIST_BUNDLED_SKILLS_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "bundled-skills"),
    join(here, "../../bundled-skills"),
    join(process.cwd(), "bundled-skills"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return resolve(match || candidates[1]);
}

export function listBundledSkills(): SkillSummary[] {
  return readSkillDirs(getBundledSkillsRoot(), "bundled");
}

export function listInstalledSkills(
  repoPath?: string,
  scope: SkillInstallScope | "all" = "all",
): { global: SkillSummary[]; project: SkillSummary[] } {
  const globalSkills = scope === "project" ? [] : readSkillDirs(getGlobalSkillsRoot(), "global");
  const projectSkills =
    scope === "global" || !repoPath ? [] : readSkillDirs(getProjectSkillsRoot(repoPath), "project");
  return { global: globalSkills, project: projectSkills };
}

export function listVisibleSkills(repoPath?: string): SkillSummary[] {
  const { global, project } = listInstalledSkills(repoPath, "all");
  const visible = new Map<string, SkillSummary>();
  for (const skill of global) visible.set(skill.id, skill);
  for (const skill of project) visible.set(skill.id, skill);
  return Array.from(visible.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function getSkillCatalog(repoPath?: string): SkillCatalogView {
  const bundled = listBundledSkills();
  const installed = listInstalledSkills(repoPath, "all");
  const installedById = new Map<string, SkillInstallScope[]>();

  for (const skill of installed.global) installedById.set(skill.id, ["global"]);
  for (const skill of installed.project) {
    const scopes = installedById.get(skill.id) || [];
    installedById.set(skill.id, Array.from(new Set<SkillInstallScope>([...scopes, "project"])));
  }

  const available: SkillCatalogEntry[] = bundled.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: "bundled",
    sourceValue: skill.id,
    installedScopes: installedById.get(skill.id) || [],
  }));

  for (const skill of [...installed.global, ...installed.project]) {
    const source = skill.installMetadata?.source;
    if (!source || source.kind === "bundled") continue;
    if (available.some((entry) => entry.id === skill.id)) continue;
    available.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: source.kind,
      sourceValue: source.value,
      installedScopes: installedById.get(skill.id) || [],
    });
  }

  available.sort((a, b) => a.id.localeCompare(b.id));

  return {
    available,
    installedGlobal: installed.global,
    installedProject: installed.project,
  };
}

export async function installSkill(input: {
  skillOrUrl: string;
  scope?: SkillInstallScope;
  repoPath?: string;
}): Promise<SkillSummary> {
  const scope: SkillInstallScope = input.scope || (input.repoPath ? "project" : "global");
  const source = detectInstallSource(input.skillOrUrl);

  let markdown = "";
  let copyFromDir: string | undefined;

  if (source.kind === "bundled") {
    const bundled = listBundledSkills().find((skill) => skill.id === source.value);
    if (!bundled) throw new Error(`Unknown bundled skill: ${source.value}`);
    markdown = readFileSync(bundled.skillPath, "utf8");
    copyFromDir = bundled.dirPath;
  } else if (source.kind === "local") {
    const local = readLocalSkillSource(source.value);
    markdown = local.markdown;
    copyFromDir = local.copyFromDir;
  } else {
    const remote = await readRemoteSkillSource(source.value);
    markdown = remote.markdown;
  }

  const { frontmatter } = splitSkillMarkdown(markdown);
  const id = ensureValidSkillId(frontmatter.name);
  const destRoot = prepareDestRoot(scope, input.repoPath);
  const destDir = join(destRoot, id);
  writeSkillFiles(destDir, markdown, copyFromDir);
  writeInstallMetadata(destDir, {
    installedAt: nowIso(),
    scope,
    source,
  });

  const installed = readSkillDirectory(destDir, scope);
  if (!installed) throw new Error(`Installed skill is missing ${SKILL_FILE}`);
  return installed;
}

export function removeSkill(skillId: string, scope: SkillInstallScope, repoPath?: string): boolean {
  const id = ensureValidSkillId(skillId);
  const root = scope === "project" ? getProjectSkillsRoot(repoPath || "") : getGlobalSkillsRoot();
  const dir = join(root, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function readInstalledSkill(
  skillId: string,
  options: { repoPath?: string; scope?: SkillInstallScope | "visible"; file?: string } = {},
): SkillSummary {
  const id = ensureValidSkillId(skillId);
  const { repoPath, scope = "visible" } = options;

  const candidates: SkillSummary[] =
    scope === "visible"
      ? listVisibleSkills(repoPath)
      : scope === "project"
        ? listInstalledSkills(repoPath, "project").project
        : listInstalledSkills(repoPath, "global").global;

  const skill = candidates.find((entry) => entry.id === id);
  if (!skill) throw new Error(`Skill not installed: ${id}`);

  if (!options.file) return skill;

  const target = resolve(skill.dirPath, "references", options.file);
  if (!target.startsWith(resolve(join(skill.dirPath, "references")))) {
    throw new Error("Reference file escapes skill references dir");
  }
  if (!existsSync(target)) throw new Error(`Reference file not found: ${options.file}`);

  return {
    ...skill,
    body: readFileSync(target, "utf8"),
  };
}

export function buildSkillIndex(repoPath?: string, maxChars = 2200): string {
  const skills = listVisibleSkills(repoPath);
  if (!skills.length) return "";

  const lines: string[] = ["Installed skills:"];
  let used = lines[0].length;
  for (const skill of skills) {
    const line = `- ${skill.id} [${skill.scope}]: ${skill.description}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  lines.push("Use list_skills() to inspect the catalog and read_skill({skillId}) before applying a skill.");
  return lines.join("\n");
}
