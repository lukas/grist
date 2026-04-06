import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Load the first existing `.env` from candidate paths (not committed; see `.env.example`).
 * Call once from Electron main before `openDatabase` / `loadAppSettings`.
 */
export function loadDotenvFile(extraPaths: string[] = []): string | null {
  const paths = [...extraPaths, join(process.cwd(), ".env")];
  for (const p of paths) {
    if (p && existsSync(p)) {
      dotenv.config({ path: p, override: false });
      return p;
    }
  }
  return null;
}
