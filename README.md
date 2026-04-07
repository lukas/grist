# Grist

Local **macOS Electron** app to supervise a small team of coding agents against a **git repo**: parallel workers (max 4), structured tool loop, SQLite state, optional **git worktrees** for patches, reducer + verifier artifacts.

Repository: [github.com/lukas/grist](https://github.com/lukas/grist)

## Quick start

```bash
npm install
cp .env.example .env   # optional: local secrets (gitignored); set GRIST_KIMI_* etc.
npm test              # vitest + preload bundle checks + on macOS: Electron smoke (`SMOKE_OK`)
npm run test:electron-smoke   # only the Electron preload check (also runs inside npm test on macOS)
npm run dev             # UI: http://localhost:5173 + Electron window
npm run build           # production bundles: dist-electron/, dist-frontend/
```

`npm run dev` and `npm start` run `electron-rebuild` for **better-sqlite3** so the native addon matches Electron’s Node ABI. `npm test` runs `npm rebuild better-sqlite3` first so Vitest keeps using your system Node.

Default model provider is **mock** (no API keys). Set providers under **Providers** in the app (stored in SQLite).

## Layout (spec §19)

- `electron/` — main process, preload, IPC wiring
- `frontend/` — React UI (Vite + Tailwind)
- `backend/` — orchestrator, DB, tools, providers, workspace helpers
- `shared/` — IPC channel constants and action types
- `docs/AGENT_HANDOFF.md` — architecture + contracts for future agents
- `IMPLEMENTATION_CHECKLIST.md` — spec traceability + manual acceptance steps

## Implementation log (running)

| When | What |
|------|------|
| 2026-04-06 | **grV0 scaffold:** SQLite jobs/tasks/artifacts/events/settings; template planner (4× analysis + reducer); scheduler with concurrency 4, stall + duplicate-tool hints; worker structured JSON loop; reducer + verifier passes; full tool surface (repo, scratchpad, artifacts, execution with allowlist, worktree patch tools); providers: mock, Claude, Codex (OpenAI API), Kimi (OpenAI-compatible); Electron IPC + React Mission Control / tasks / detail / findings / events / patch table; `openPath` for Finder; vitest for deps, DB insert, allowlist. |
| 2026-04-06 | **Dev UX:** `@electron/rebuild` + `rebuild:electron` before Electron; `pretest` / `test:watch` rebuild `better-sqlite3` for system Node so tests and Electron both work. |
| 2026-04-06 | **Product name:** shipped as **Grist** (npm package `grist`, DB file `grist.sqlite`). Older `swarm.sqlite` is not migrated automatically. |
| 2026-04-06 | **`.env`:** gitignored repo-root `.env` loaded on startup; `GRIST_KIMI_*` + `GRIST_DEFAULT_PROVIDER`; DB settings override env when set. |
| 2026-04-06 | **Mission bar:** **Enter** in goal or notes triggers **Plan & run**. No repo? **RepoDialog** opens (recent repos, browse, paste, create new via git init). |
| 2026-04-06 | **Electron main:** `dotenv` is **esbuild external** so the ESM main bundle does not inline CJS `require("fs")` (avoids startup crash). |
| 2026-04-06 | **Agent loop fixes:** Normalize alt LLM field names (`tool`→`tool_name`, `args`→`tool_args`). Conversation history in prompts. Auto-pause on 3× identical call, 5 consecutive errors, or 3 empty tool names. `AutoPauseBanner` toast in UI. |
| 2026-04-06 | **Logs in repo:** JSONL logs now saved to `<repo>/.grist/logs/` (auto-gitignored). Planner view in task list shows job-level events. **History** dropdown in MissionControl to browse/reload old jobs. Most recent job auto-loaded on startup. |
| 2026-04-06 | **LLM planner:** Planner now calls the LLM with repo file listing + goal context. Creates appropriate tasks (analysis vs implementation) based on the model's reasoning. Empty repos get implementation tasks, existing codebases get analysis. All planner thinking visible in Planner view. Fallback to template plan on LLM error. |

## Spec

See **grV0 IMPLEMENTATION SPEC** (product source). This README + `IMPLEMENTATION_CHECKLIST.md` + `docs/AGENT_HANDOFF.md` track delivery against it.
