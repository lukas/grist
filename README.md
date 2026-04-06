# Swarm Operator (grist)

Local **macOS Electron** app to supervise a small coding-agent swarm against a **git repo**: parallel workers (max 4), structured tool loop, SQLite state, optional **git worktrees** for patches, reducer + verifier artifacts.

Repository: [github.com/lukas/grist](https://github.com/lukas/grist)

## Quick start

```bash
npm install
npm test              # vitest (required before claiming behavior works)
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

## Spec

See **grV0 IMPLEMENTATION SPEC** (product source). This README + `IMPLEMENTATION_CHECKLIST.md` + `docs/AGENT_HANDOFF.md` track delivery against it.
