import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME_GRIST = join(homedir(), ".grist");
const HOME_MEMORY = join(HOME_GRIST, "memory");
const HOME_SUMMARY = join(HOME_GRIST, "summary.md");
const PROJECTS_FILE = join(HOME_GRIST, "projects.json");

/** Hard caps for summary files (characters). Reflection must stay within these. */
export const REPO_SUMMARY_MAX_CHARS = 2500;
export const HOME_SUMMARY_MAX_CHARS = 1500;

/** Token budget for memory injected into prompts (~4 chars per token). */
const MEMORY_TOKEN_BUDGET = 1500;
const CHARS_PER_TOKEN = 4;
const MEMORY_CHAR_BUDGET = MEMORY_TOKEN_BUDGET * CHARS_PER_TOKEN; // 6000 chars

const DEFAULT_HOME_SUMMARY = `# Grist — Global Notes

Cross-project learnings and patterns observed across all tasks.
`;

const DEFAULT_REPO_SUMMARY = `# Project Notes

Key patterns, conventions, and learnings specific to this repository.
`;

// --- Directory management ---

export function ensureHomeMemory(): void {
  mkdirSync(HOME_MEMORY, { recursive: true });
  if (!existsSync(HOME_SUMMARY)) {
    writeFileSync(HOME_SUMMARY, DEFAULT_HOME_SUMMARY, "utf8");
  }
}

export function ensureRepoMemory(repoPath: string): void {
  const dir = join(repoPath, ".grist", "memory");
  const summary = join(repoPath, ".grist", "summary.md");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(summary)) {
    writeFileSync(summary, DEFAULT_REPO_SUMMARY, "utf8");
  }
  ensureGitignore(repoPath);
  trackProject(repoPath);
}

function ensureGitignore(repoPath: string): void {
  const gi = join(repoPath, ".gitignore");
  const entry = ".grist/";
  if (existsSync(gi)) {
    const content = readFileSync(gi, "utf8");
    if (content.includes(entry)) return;
    writeFileSync(gi, content.trimEnd() + "\n" + entry + "\n", "utf8");
  } else {
    writeFileSync(gi, entry + "\n", "utf8");
  }
}

// --- Project registry ---

export interface ProjectEntry {
  path: string;
  name: string;
  firstSeen: string;
  lastUsed: string;
}

function loadProjects(): ProjectEntry[] {
  if (!existsSync(PROJECTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, "utf8")) as ProjectEntry[];
  } catch {
    return [];
  }
}

function saveProjects(projects: ProjectEntry[]): void {
  ensureHomeMemory();
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf8");
}

function trackProject(repoPath: string): void {
  const projects = loadProjects();
  const now = new Date().toISOString();
  const idx = projects.findIndex((p) => p.path === repoPath);
  if (idx >= 0) {
    projects[idx].lastUsed = now;
  } else {
    projects.push({
      path: repoPath,
      name: basename(repoPath),
      firstSeen: now,
      lastUsed: now,
    });
  }
  saveProjects(projects);
}

export function listProjects(): ProjectEntry[] {
  return loadProjects().sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
}

// --- Summary read/write ---

export function readHomeSummary(): string {
  ensureHomeMemory();
  return readFileSync(HOME_SUMMARY, "utf8");
}

export function writeHomeSummary(content: string): void {
  ensureHomeMemory();
  writeFileSync(HOME_SUMMARY, content.slice(0, HOME_SUMMARY_MAX_CHARS), "utf8");
}

export function readRepoSummary(repoPath: string): string {
  ensureRepoMemory(repoPath);
  return readFileSync(join(repoPath, ".grist", "summary.md"), "utf8");
}

export function writeRepoSummary(repoPath: string, content: string): void {
  ensureRepoMemory(repoPath);
  writeFileSync(join(repoPath, ".grist", "summary.md"), content.slice(0, REPO_SUMMARY_MAX_CHARS), "utf8");
}

// --- Memory file read/write ---

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function writeHomeMemoryFile(taskName: string, content: string): string {
  ensureHomeMemory();
  const fname = `${timestamp()}-${sanitizeName(taskName)}.md`;
  const fpath = join(HOME_MEMORY, fname);
  writeFileSync(fpath, content, "utf8");
  return fpath;
}

export function writeRepoMemoryFile(repoPath: string, taskName: string, content: string): string {
  ensureRepoMemory(repoPath);
  const fname = `${timestamp()}-${sanitizeName(taskName)}.md`;
  const fpath = join(repoPath, ".grist", "memory", fname);
  writeFileSync(fpath, content, "utf8");
  return fpath;
}

export interface MemoryFileInfo {
  name: string;
  content: string;
  mtime: number;
}

export function listHomeMemoryFiles(): string[] {
  ensureHomeMemory();
  return readdirSync(HOME_MEMORY).filter((f) => f.endsWith(".md")).sort();
}

export function listRepoMemoryFiles(repoPath: string): string[] {
  ensureRepoMemory(repoPath);
  const dir = join(repoPath, ".grist", "memory");
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

export function readHomeMemoryFile(name: string): string {
  const fpath = join(HOME_MEMORY, name);
  if (!existsSync(fpath)) return "";
  return readFileSync(fpath, "utf8");
}

export function readRepoMemoryFile(repoPath: string, name: string): string {
  const fpath = join(repoPath, ".grist", "memory", name);
  if (!existsSync(fpath)) return "";
  return readFileSync(fpath, "utf8");
}

function loadMemoryFilesWithMeta(dir: string): MemoryFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => {
      const fpath = join(dir, name);
      const content = readFileSync(fpath, "utf8");
      const mtime = statSync(fpath).mtimeMs;
      return { name, content, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

// --- Relevance scoring ---

function extractKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  );
}

function relevanceScore(fileContent: string, goalKeywords: Set<string>): number {
  if (goalKeywords.size === 0) return 0;
  const fileWords = extractKeywords(fileContent);
  let hits = 0;
  for (const kw of goalKeywords) {
    if (fileWords.has(kw)) hits++;
  }
  return hits / goalKeywords.size;
}

// --- Token-budgeted context collection ---

/**
 * Build a compact memory context block for injection into agent prompts.
 * Hard-capped at ~1500 tokens. Strategy:
 *   1. Repo summary (up to 50% of budget)
 *   2. Global summary (up to 25% of budget)
 *   3. Relevant memory file snippets (remaining budget)
 *
 * Memory files are ranked by keyword relevance to the task goal,
 * with recency as a tiebreaker.
 */
export function collectMemoryContext(repoPath: string, taskGoal?: string): string {
  const parts: string[] = [];
  let budgetLeft = MEMORY_CHAR_BUDGET;

  // 1. Repo summary — most valuable, gets up to half the budget
  const repoSummary = readRepoSummary(repoPath).trim();
  if (repoSummary && repoSummary !== DEFAULT_REPO_SUMMARY.trim()) {
    const maxRepo = Math.min(repoSummary.length, Math.floor(MEMORY_CHAR_BUDGET * 0.50));
    const trimmed = repoSummary.slice(0, maxRepo);
    parts.push(`## Project memory\n${trimmed}`);
    budgetLeft -= trimmed.length + 20;
  }

  // 2. Global summary — up to 25% of budget
  const homeSummary = readHomeSummary().trim();
  if (homeSummary && homeSummary !== DEFAULT_HOME_SUMMARY.trim()) {
    const maxHome = Math.min(homeSummary.length, Math.floor(MEMORY_CHAR_BUDGET * 0.25));
    const trimmed = homeSummary.slice(0, maxHome);
    parts.push(`## Global memory\n${trimmed}`);
    budgetLeft -= trimmed.length + 20;
  }

  // 3. Memory files — ranked by relevance to task goal, newest as tiebreaker
  if (budgetLeft > 200) {
    const goalKw = taskGoal ? extractKeywords(taskGoal) : new Set<string>();
    const repoDir = join(repoPath, ".grist", "memory");
    const repoFiles = loadMemoryFilesWithMeta(repoDir);
    const homeFiles = loadMemoryFilesWithMeta(HOME_MEMORY);

    const scored = [
      ...repoFiles.map((f) => ({ ...f, source: "project" as const, score: relevanceScore(f.content, goalKw) })),
      ...homeFiles.map((f) => ({ ...f, source: "global" as const, score: relevanceScore(f.content, goalKw) })),
    ].sort((a, b) => {
      // Relevance first, then recency
      if (b.score !== a.score) return b.score - a.score;
      return b.mtime - a.mtime;
    });

    const snippets: string[] = [];
    for (const f of scored) {
      if (budgetLeft < 100) break;
      const firstLine = f.content.trim().split("\n")[0].slice(0, 120);
      const tag = f.source === "global" ? "[global]" : "[project]";
      const line = `- ${tag} ${f.name}: ${firstLine}`;
      if (line.length > budgetLeft) break;
      snippets.push(line);
      budgetLeft -= line.length + 2;
    }

    if (snippets.length > 0) {
      parts.push(`## Memory notes\n${snippets.join("\n")}\n(Use read_memory to see full contents)`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

/**
 * Full memory dump for the UI drawer (not token-budgeted).
 */
export function getFullMemoryData(repoPath: string): {
  repoSummary: string;
  homeSummary: string;
  repoFiles: MemoryFileInfo[];
  homeFiles: MemoryFileInfo[];
} {
  const repoDir = join(repoPath, ".grist", "memory");
  return {
    repoSummary: readRepoSummary(repoPath),
    homeSummary: readHomeSummary(),
    repoFiles: loadMemoryFilesWithMeta(repoDir),
    homeFiles: loadMemoryFilesWithMeta(HOME_MEMORY),
  };
}
