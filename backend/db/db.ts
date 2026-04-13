import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "..", "..", "backend", "db", "schema.sql"),
    join(process.cwd(), "backend", "db", "schema.sql"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join(", ")})`);
}

let _db: Database.Database | null = null;

function ensureTaskColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  const required: Array<{ name: string; sql: string }> = [
    { name: "git_branch", sql: "ALTER TABLE tasks ADD COLUMN git_branch TEXT NOT NULL DEFAULT ''" },
    { name: "base_ref", sql: "ALTER TABLE tasks ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''" },
    { name: "runtime_json", sql: "ALTER TABLE tasks ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}'" },
  ];
  for (const column of required) {
    if (!names.has(column.name)) {
      db.exec(column.sql);
    }
  }
}

export function openDatabase(filePath: string): Database.Database {
  if (_db) {
    _db.close();
    _db = null;
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(loadSchemaSql());
  ensureTaskColumns(db);
  _db = db;
  return _db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error("Database not open");
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Test helper */
export function resetDbSingleton(): void {
  _db = null;
}
