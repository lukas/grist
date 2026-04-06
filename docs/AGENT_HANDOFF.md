# Swarm Operator (grist) — agent handoff

## What this repo is

macOS Electron app for **supervising** a small coding-agent swarm on a **local git repo**: planner → scheduler (≤4 workers) → reducer → optional patch worktrees + verifier. v0 prioritizes inspectability and operator control, not autonomy.

## Run / build

```bash
cd grist
npm install
npm test
npm run build          # dist-electron + dist-frontend
npm run dev            # Vite :5173 + Electron (needs display)
```

**Native module:** `better-sqlite3` must match the Node ABI. `npm run dev` / `npm start` run `electron-rebuild -f -w better-sqlite3`. `npm test` runs `npm rebuild better-sqlite3` first (Vitest uses system Node, not Electron).

**Black screen in dev:** A strict `Content-Security-Policy` meta (e.g. `script-src 'self'` only) blocks Vite HMR (`unsafe-eval`). The app HTML intentionally omits a tight CSP for this local Electron shell.

- **DB:** `app.getPath('userData')/swarm.sqlite`
- **Scratch/worktrees:** `userData/workspace/jobs/<jobId>/…` (override via settings `appWorkspaceRoot`)
- **Schema file:** copied to `dist-electron/schema.sql` on electron build; runtime loads via `fileURLToPath` + fallbacks (`backend/db/db.ts`)

## Architecture map

| Area | Path |
|------|------|
| Electron main, IPC | `electron/main.ts`, `electron/preload.ts` |
| IPC names | `shared/ipc.ts` |
| DB schema | `backend/db/schema.sql` |
| Repos | `backend/db/*Repo.ts` |
| Orchestrator | `backend/orchestrator/appOrchestrator.ts` (facade), `planner.ts`, `scheduler.ts`, `workerRunner.ts`, `reducer.ts`, `verifier.ts` |
| Providers | `backend/providers/*` + `providerFactory.ts` |
| Tools | `backend/tools/executeTool.ts` (+ split modules) |
| Workspace | `backend/workspace/*` |
| React UI | `frontend/src/App.tsx`, `frontend/src/components/*` |

## Contracts / invariants

- **One tool call per model turn** — `WorkerDecisionSchema` in `backend/types/taskState.ts`.
- **Tool allowlist** — `task.allowed_tools_json`; `run_command_safe` / `run_tests` also gated by `settings.commandAllowlist` (defaults in `appSettings.ts`).
- **Writes** — `write_file` / `apply_patch` only under `task.worktree_path` when set.
- **Events** — tool calls and orchestration should call `insertEvent` (worker emits via `ToolContext.emit`).
- **Pause** — job-level pause: workers spin until `job.status !== 'paused'`; task-level pause: same + `task.status === 'paused'`. **Stop** aborts in-flight work via `AbortController`.

## Provider env / settings

SQLite `settings` table + optional env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Kimi uses OpenAI-compatible HTTP; empty API key omits `Authorization` header.

## Known gaps / follow-ups

- Planner is **template-based** (no LLM call yet); `planner_model_provider` on job is reserved for a future LLM planner.
- **Command palette** and **open in editor** not implemented.
- Reducer/verifier need real providers for useful output; **mock** provider drives deterministic CI/offline loops.
- Auto-merge of competing patches: **not** implemented (by design).

## Implementation log (running)

| Date | Change |
|------|--------|
| 2026-04-06 | Initial grV0: Electron+Vite+React+Tailwind, SQLite schema, planner/scheduler/worker/reducer/verifier, tools, IPC UI, vitest (deps + allowlist + DB), docs + checklist. |
