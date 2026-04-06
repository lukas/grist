import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function ensureScratchpad(path: string, seed = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, seed || "# Scratchpad\n\n", "utf8");
  }
}

export function readScratchpad(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function writeScratchpad(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function appendScratchpad(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, content, "utf8");
}
