import { getDb } from "./db.js";

export function getSetting(key: string): unknown | undefined {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: unknown): void {
  const v = JSON.stringify(value);
  getDb()
    .prepare(`INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
    .run(key, v);
}

export function getAllSettings(): Record<string, unknown> {
  const rows = getDb().prepare("SELECT key, value_json FROM settings").all() as { key: string; value_json: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value_json) as unknown;
    } catch {
      out[r.key] = r.value_json;
    }
  }
  return out;
}
