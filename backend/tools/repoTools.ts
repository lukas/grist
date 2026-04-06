import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { assertUnderRoot } from "./pathGuard.js";
import type { ToolContext, ToolResult } from "./toolTypes.js";

function listFilesRecursive(root: string, base: string, maxFiles: number, out: string[]): void {
  if (out.length >= maxFiles) return;
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === ".git" || e === "node_modules" || e === ".swarm_operator") continue;
    const full = join(base, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listFilesRecursive(root, full, maxFiles, out);
    } else {
      out.push(relative(root, full) || e);
    }
    if (out.length >= maxFiles) return;
  }
}

export function toolListFiles(ctx: ToolContext, args: { path?: string; recursive?: boolean }): ToolResult {
  try {
    const rel = args.path || ".";
    const base = assertUnderRoot(ctx.repoPath, rel);
    if (!existsSync(base)) return { ok: false, error: "path not found" };
    const max = 400;
    const names: string[] = [];
    if (args.recursive) {
      listFilesRecursive(ctx.repoPath, base, max, names);
    } else {
      for (const e of readdirSync(base)) {
        names.push(join(rel === "." ? "" : rel, e).replace(/^\//, ""));
      }
    }
    return { ok: true, data: { files: names.slice(0, max) } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolReadFile(
  ctx: ToolContext,
  args: { path: string; startLine?: number; endLine?: number }
): ToolResult {
  try {
    const full = assertUnderRoot(ctx.repoPath, args.path);
    if (!existsSync(full)) return { ok: false, error: "file not found" };
    const raw = readFileSync(full, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = (args.startLine ?? 1) - 1;
    const end = args.endLine != null ? args.endLine : lines.length;
    const slice = lines.slice(Math.max(0, start), Math.max(0, end));
    return { ok: true, data: { path: args.path, lines: slice.join("\n"), totalLines: lines.length } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolGrepCode(ctx: ToolContext, args: { pattern: string; scopePaths?: string[] }): ToolResult {
  try {
    const scopes = args.scopePaths?.length ? args.scopePaths : ["."];
    const maxHits = 80;
    const hits: { file: string; line: number; text: string }[] = [];
    const re = new RegExp(args.pattern, "i");

    const walkFile = (file: string) => {
      if (hits.length >= maxHits) return;
      const full = assertUnderRoot(ctx.repoPath, file);
      if (!existsSync(full) || !statSync(full).isFile()) return;
      if (full.includes(`${ctx.repoPath}/.git`)) return;
      const text = readFileSync(full, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (hits.length >= maxHits) return;
        if (re.test(line)) hits.push({ file, line: i + 1, text: line.slice(0, 500) });
      });
    };

    const walkDir = (dirRel: string) => {
      const base = assertUnderRoot(ctx.repoPath, dirRel);
      if (!existsSync(base)) return;
      const stack = [base];
      while (stack.length && hits.length < maxHits) {
        const d = stack.pop()!;
        let ents: string[];
        try {
          ents = readdirSync(d);
        } catch {
          continue;
        }
        for (const e of ents) {
          if (e === ".git" || e === "node_modules") continue;
          const p = join(d, e);
          let st;
          try {
            st = statSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) stack.push(p);
          else {
            const rel = relative(ctx.repoPath, p);
            walkFile(rel);
          }
        }
      }
    };

    for (const s of scopes) {
      const full = assertUnderRoot(ctx.repoPath, s);
      if (existsSync(full) && statSync(full).isFile()) walkFile(relative(ctx.repoPath, full));
      else walkDir(s);
    }

    return { ok: true, data: { hits } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function toolReadGitHistory(ctx: ToolContext, args: { path?: string; limit?: number }): ToolResult {
  const limit = args.limit ?? 20;
  const pathSpec = args.path ? ["--", args.path] : [];
  const r = spawnSync("git", ["log", `--max-count=${limit}`, "--oneline", ...pathSpec], {
    cwd: ctx.repoPath,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0) return { ok: false, error: r.stderr || "git log failed" };
  return { ok: true, data: { log: (r.stdout || "").trim() } };
}

export function toolListChangedFiles(ctx: ToolContext, args: { revRange?: string }): ToolResult {
  const range = args.revRange || "HEAD~1..HEAD";
  const r = spawnSync("git", ["diff", "--name-only", range], {
    cwd: ctx.repoPath,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0) return { ok: false, error: r.stderr || "git diff failed" };
  const files = (r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, data: { files } };
}
