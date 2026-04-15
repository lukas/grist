import { getFullMemoryData } from "../memory/memoryManager.js";

export const MAX_MEMORY_NOTES_FOR_PLANNER = 5;
export const MAX_MEMORY_NOTES_FOR_WORKER = 3;

function extractKeywords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

function score(content: string, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const haystack = content.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) hits += 1;
  }
  return hits;
}

function renderContext(
  repoSummary: string,
  homeSummary: string,
  repoFiles: { name: string; content: string; mtime: number }[],
  homeFiles: { name: string; content: string; mtime: number }[],
  goal: string,
  maxNotes: number,
): string {
  const keywords = extractKeywords(goal);
  const ranked = [
    ...repoFiles.map((file) => ({ ...file, scope: "project" as const, rank: score(file.content, keywords) })),
    ...homeFiles.map((file) => ({ ...file, scope: "global" as const, rank: score(file.content, keywords) })),
  ].sort((a, b) => (b.rank - a.rank) || (b.mtime - a.mtime));
  const notes = ranked.slice(0, maxNotes).map((file) =>
    `- [${file.scope}] ${file.name}: ${file.content.trim().split("\n")[0]?.slice(0, 180) || ""}`
  );
  const parts = [];
  if (repoSummary.trim()) parts.push(`## Project memory\n${repoSummary.trim().slice(0, 1500)}`);
  if (homeSummary.trim()) parts.push(`## Global memory\n${homeSummary.trim().slice(0, 800)}`);
  if (notes.length > 0) parts.push(`## Memory notes\n${notes.join("\n")}`);
  return parts.join("\n\n");
}

export function getPlannerContext(repoPath: string, jobGoal: string): { memoryContext: string } {
  const data = getFullMemoryData(repoPath);
  return {
    memoryContext: renderContext(data.repoSummary, data.homeSummary, data.repoFiles, data.homeFiles, jobGoal, MAX_MEMORY_NOTES_FOR_PLANNER),
  };
}

export function getWorkerContext(repoPath: string, taskGoal: string): { memoryContext: string } {
  const data = getFullMemoryData(repoPath);
  return {
    memoryContext: renderContext(data.repoSummary, data.homeSummary, data.repoFiles, data.homeFiles, taskGoal, MAX_MEMORY_NOTES_FOR_WORKER),
  };
}

export function getRepairContext(repoPath: string, taskGoal: string): { memoryContext: string } {
  const data = getFullMemoryData(repoPath);
  return {
    memoryContext: renderContext(data.repoSummary, data.homeSummary, data.repoFiles, data.homeFiles, taskGoal, MAX_MEMORY_NOTES_FOR_WORKER),
  };
}
