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

### Paths

- **DB:** `app.getPath('userData')/grist.sqlite`
- **Logs:** `<repo>/.grist/logs/job-N/task-N.jsonl`
- **Scratch/worktrees:** `userData/workspace/jobs/<jobId>/…`
- **Schema file:** copied to `dist-electron/schema.sql` on electron build

## Architecture map

### Unified task model

Everything is a **task**. The old "jobs" table is kept internally but hidden behind `rootTaskFacade.ts`.

| Concept | Description |
|---------|-------------|
| **Root task** | Top-level task created by user (`kind=root`). The only entity the frontend sees. |
| **Planner task** | `kind=planner`, child of root. Plans subtasks. |
| **Work tasks** | Analysis/implementation tasks created by the planner. Children of root. |
| **Subtasks** | Spawned by work tasks via `spawn_subtasks`. Children of their parent. |

### Key files

| Area | Path |
|------|------|
| Electron main, IPC | `electron/main.ts`, `electron/preload.ts` |
| IPC contracts | `shared/ipc.ts` |
| DB schema | `backend/db/schema.sql` |
| Repos | `backend/db/*Repo.ts` |
| **Root task facade** | `backend/db/rootTaskFacade.ts` |
| Orchestrator | `backend/orchestrator/appOrchestrator.ts`, `planner.ts`, `scheduler.ts`, `workerRunner.ts`, `reducer.ts`, `verifier.ts` |
| Providers | `backend/providers/*` + `providerFactory.ts` |
| Tools | `backend/tools/executeTool.ts` |
| React UI | `frontend/src/App.tsx`, `frontend/src/components/*` |

### Frontend → IPC API

The frontend uses **only** the unified task API. No `jobId` anywhere in the renderer.

| IPC channel | Purpose |
|-------------|---------|
| `createTask` | Create root task (returns root task ID) |
| `startTask` | Plan + start scheduler in one call |
| `listRootTasks` | List root tasks (most recent first), optional repo filter |
| `getRootTask` | Get root task by ID |
| `getChildTasks` | Get child tasks for a root task (excludes root/planner kinds) |
| `getEventsForTask` | Events by task ID (no jobId needed) |
| `getAllEvents` | All events for a root task's job |
| `stopTask` | Stop a root task |
| `rootTaskControl` | Pause/resume/stop a root task |
| `taskControl` | Pause/stop/redirect/fork individual tasks |

### Frontend components

| Component | Behavior |
|-----------|----------|
| `App.tsx` | State: `rootTaskId`, `selectedTaskId`. Uses `createTask`/`startTask` to run. |
| `MissionControl` | Header bar. Repo picker, provider dot, pause/resume/stop via `rootTaskControl`. |
| `TaskList` | Left sidebar. Root tasks as expandable nodes, child tasks as tree. Filters out `root`/`planner` kinds. |
| `TaskDetail` | Main panel. Chat-style event view. Loads events via `getEventsForTask(taskId)`. |

## Contracts / invariants

- **Root task facade** — `rootTaskFacade.ts` wraps `insertJob` + `insertTask(kind='root')`. Root task ID is the only ID the frontend uses. `rootTaskToJobId()` resolves internally.
- **Planner is a real task** — `planner.ts` inserts `kind=planner` task as child of root. Events go to `task_id=plannerTaskId`.
- **Scheduler skips root/planner** — `NON_SCHEDULABLE_KINDS = {root, planner}`.
- **Auto-pause** — 3× identical tool call, 5 consecutive errors, 3 empty tool names.
- **Stall detection** — debounced (one event per episode), escalation: warn@30s, pause@5min, fail@15min. Tasks in `current_action: "thinking"` are exempt.

## Provider env / settings

SQLite `settings` table **or** repo-root **`.env`** (gitignored). `loadAppSettings()` prefers `.env` values when set. Prefix: `GRIST_*`. Also accepts `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## CLI

```bash
node dist-electron/grist-cli.js <command>
```

Uses the unified task API. Key commands: `run`, `list`, `subtasks`, `status`, `summary`, `watch`, `pause`/`resume`/`stop`. All take root task IDs.

## Known gaps

- Command palette and open-in-editor not implemented.
- Reducer/verifier need real providers for useful output.
- Schema migration (merge jobs into tasks table) is a future follow-up.
- See `docs/IMPROVEMENT_IDEAS.md` for future enhancement ideas.

## Implementation log

| Date | Change |
|------|--------|
| 2026-04-06 | Initial v0: Electron+Vite+React+Tailwind, SQLite, planner/scheduler/worker, tools, IPC UI. |
| 2026-04-08 | Unified task model: root task facade, planner as real task. |
| 2026-04-08 | Bug fixes: retry on model errors, stall dedup, job status reflects failed tasks, maxTokens 8K→16K. |
| 2026-04-08 | Frontend fully wired to unified task API. Removed all `jobId` references from renderer. Deleted orphaned components (EventStream, PatchComparison, GlobalFindings, MemoryDrawer, MemoryViewer, SkillsModal). |
