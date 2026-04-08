# Grist

Local **macOS Electron** app to supervise a small team of coding agents against a **git repo**: parallel workers (max 4), structured tool loop, SQLite state, optional **git worktrees** for patches, reducer + verifier artifacts.

## Quick start

```bash
npm install
cp .env.example .env   # optional: local secrets (gitignored)
npm test               # vitest + preload bundle + Electron smoke on macOS
npm run dev            # UI: http://localhost:5173 + Electron window
npm run build          # production: dist-electron/ + dist-frontend/
```

`npm run dev` runs `electron-rebuild` for **better-sqlite3** (native addon must match Electron's Node ABI). Default provider is **mock** (no API keys needed).

## Architecture

Everything is a **task**. When you type a goal and hit Run:
1. A **root task** is created
2. A **planner task** analyzes the goal and creates work tasks
3. **Work tasks** (analysis/implementation) execute in parallel (max 4)
4. Work tasks can spawn their own **subtasks**

All tasks share the same UI: a tree in the sidebar, chat-style event detail with operator messaging on the right.

## Layout

- `electron/` — main process, preload, IPC wiring
- `frontend/` — React UI (Vite + Tailwind)
- `backend/` — orchestrator, DB, tools, providers, workspace helpers
- `backend/db/rootTaskFacade.ts` — unified task API wrapping internal tables
- `shared/ipc.ts` — IPC channel constants and action types
- `docs/AGENT_HANDOFF.md` — architecture + contracts for agents

## Frontend API

The frontend uses a unified task API (no "job" concept exposed):

| Method | Description |
|--------|-------------|
| `createTask` | Create a new root task |
| `startTask` | Plan and start execution |
| `listRootTasks` | List all root tasks |
| `getChildTasks` | Get subtasks for a root task |
| `getEventsForTask` | Get events for any task |
| `rootTaskControl` | Pause/resume/stop a root task |
| `sendTaskMessage` | Send a message to a running task's agent |

## CLI

```bash
node dist-electron/grist-cli.js run --repo /path/to/repo --goal "your goal"
node dist-electron/grist-cli.js list            # list all root tasks
node dist-electron/grist-cli.js status <taskId>  # task + subtask statuses
node dist-electron/grist-cli.js watch <taskId>   # live tail events
```

## Recent improvements

- **Parallel greenfield planning**: Empty repos get an architect task + parallel module tasks (not 1 monolithic task)
- **Retry on model errors**: Workers retry LLM/parse errors up to 3× with backoff
- **Git diff captures new files**: Uses `git add -A` + `--cached` diff to include untracked files
- **Expanded allowlist**: Common dev commands (npm, node, python, git, curl, etc.) + wrapper support (timeout, pipes)
- **Memory system**: `write_memory`/`read_memory` tools + async post-task reflection
- **Compaction preserves file list**: "Files written" entry survives context compaction

## Spec

See `docs/AGENT_HANDOFF.md` for architecture details and contracts.
