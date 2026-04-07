# Grist — agent handoff

## What this repo is

**Grist** is a macOS Electron app for **supervising** a small team of coding agents on a **local git repo**: planner → scheduler (≤4 workers) → reducer → optional patch worktrees + verifier. v0 prioritizes inspectability and operator control, not autonomy.

## Run / build

```bash
cd grist
npm install
npm test
npm run build          # dist-electron + dist-frontend
npm run dev            # Vite :5173 + Electron (needs display)
npm run test:electron-smoke   # build + Electron-only check for window.grist
```

**Tests:** `npm test` runs Vitest (including `preloadBundle.test.ts`: CJS preload shape) and, on **macOS** or when `DISPLAY` / `RUN_ELECTRON_SMOKE=1` is set, `electron/smoke.cjs` (expect `SMOKE_OK`).

**Native module:** `better-sqlite3` must match the Node ABI. `npm run dev` / `npm start` run `electron-rebuild -f -w better-sqlite3`. `npm test` runs `npm rebuild better-sqlite3` first (Vitest uses system Node, not Electron).

**Black screen in dev:** A strict `Content-Security-Policy` meta (e.g. `script-src 'self'` only) blocks Vite HMR (`unsafe-eval`). The app HTML intentionally omits a tight CSP for this local Electron shell.

**`window.grist` missing:** Preload is built as **`dist-electron/preload.cjs` (CommonJS)**. ESM `preload.js` with root `package.json` `"type":"module"` often fails to run under Electron’s preload loader, so `contextBridge` never runs.

**Main bundle + `dotenv`:** `dist-electron/main.js` is ESM from esbuild. **`dotenv` must stay `external`** in `scripts/build-electron.mjs`. Bundling it inlines CJS that does `require("fs")` → Electron error *Dynamic require of "fs" is not supported*.

### Paths

- **DB:** `app.getPath('userData')/grist.sqlite` (persists across restarts; stores all jobs/tasks/events)
- **Logs:** `<repo>/.grist/logs/job-N/task-N.jsonl` (JSONL per task, stored in the repo itself; `.grist` auto-added to `.gitignore`)
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
| Mission bar | **Enter** in goal or notes runs **Plan & run**. If no repo selected → opens **RepoDialog** (recent repos, browse, paste path, create new via `git init`). |
| RepoDialog | `frontend/src/components/RepoDialog.tsx`. IPC: `recentRepos` (from jobs table), `isGitRepo`, `initRepo`. |
| Left sidebar | `TaskList.tsx` — **nested tree** of all jobs (newest first). Each job expands to show **Planner** (job-level events) + task tree (hierarchical via `parent_task_id`). Clicking a job switches to it. |
| Main panel | `TaskDetail.tsx` — **chat-style dialog**. Events grouped by step; reasoning shown as text, tool call+result as ONE compact line (`✓ write_file → index.html`). Click to expand args/result/prompt/raw. |
| Layout | 2-column: 256px sidebar + flexible main. No separate event stream or right panel — everything in the chat view. |
| Logs | `backend/logging/taskLogger.ts` → `<repo>/.grist/logs/job-N/task-N.jsonl` (JSONL per task). `.grist` auto-added to `.gitignore`. |

## Contracts / invariants

- **LLM planner** — `planner.ts` scans repo (file list), sends context to LLM, which decides task count/type/deps. Primary objective: minimize wall-clock time. Post-validation enforces parallelism rules: empty repos → 1 task, small repos (<30 files) → consolidated, parallel impl tasks merged (write conflicts). Falls back to sensible defaults on LLM failure. All reasoning logged as job-level events.
- **Parallel tool calls** — Workers support `call_tool` (single) and `call_tools` (parallel array). `WorkerDecisionSchema` in `backend/types/taskState.ts`. Parallel calls run via `Promise.all`. Normalizer accepts alternate field names `tool`/`args`/`reasoning` → `tool_name`/`tool_args`/`reasoning_summary`.
- **maxTokens** — write-capable tasks get `8192` tokens; read-only get `2048`. Prevents truncated `write_file` JSON when creating large files.
- **Truncated response recovery** — if `finishReason === "length"`, worker tries to extract tool_name and tool_args from partial JSON instead of failing immediately.
- **Smart history** — `write_file`/`apply_patch` results summarized as success/fail in history (model already knows contents). Other results get up to 3000 chars.
- **Tool allowlist** — `task.allowed_tools_json`; `run_command_safe` / `run_tests` also gated by `settings.commandAllowlist` (defaults in `appSettings.ts`).
- **Writes** — `write_file` / `apply_patch` only under `task.worktree_path` when set.
- **Events** — tool calls and orchestration should call `insertEvent` (worker emits via `ToolContext.emit`).
- **Conversation history** — worker prompt includes previous tool calls + results so the model can iterate instead of repeating. System prompt tells model not to re-read files it just wrote.
- **Auto-pause** — workers auto-pause after: (a) 3× identical tool call, (b) 5 consecutive tool errors, (c) 3 steps with empty tool name. Emits `auto_pause` event + toast banner in UI via `AutoPauseBanner.tsx`.
- **Pause** — job-level pause: workers spin until `job.status !== 'paused'`; task-level pause: same + `task.status === 'paused'`. **Stop** aborts in-flight work via `AbortController`.

## Provider env / settings

SQLite `settings` table **or** repo-root **`.env`** (gitignored; see `.env.example`). `loadAppSettings()` prefers DB values when set, else env. Prefix: `GRIST_*` (e.g. `GRIST_KIMI_BASE_URL`, `GRIST_KIMI_API_KEY`, `GRIST_KIMI_MODEL`, `GRIST_DEFAULT_PROVIDER`). If Kimi URL or key is set and `GRIST_DEFAULT_PROVIDER` is unset, default provider is **kimi**. Also accepts `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` when `GRIST_*` variants are absent.

## Known gaps / follow-ups

- **Command palette** and **open in editor** not implemented.
- Reducer/verifier need real providers for useful output; **mock** provider drives deterministic CI/offline loops.

## Implementation log (running)

| Date | Change |
|------|--------|
| 2026-04-06 | Initial grV0: Electron+Vite+React+Tailwind, SQLite schema, planner/scheduler/worker/reducer/verifier, tools, IPC UI, vitest (deps + allowlist + DB), docs + checklist. |
