# Grist

Local **macOS Electron** app to supervise a typed manager-worker swarm against a **git repo**: one manager, scoped workers, structured artifacts, git-first bootstrap, best-effort standalone Docker runtimes with managed ports, isolated local branches/worktrees, and verification/summarization passes.

## Quick start

```bash
npm install
cp .env.example .env   # optional: local secrets (gitignored)
npm test               # vitest
npm run test:electron-smoke
npm run dev            # UI: http://localhost:5173 + Electron window
npm run build          # production: dist-electron/ + dist-frontend/
npm run build:cli      # build CLI artifacts for system Node
```

`npm run dev` runs `electron-rebuild` for **better-sqlite3** (native addon must match Electron's Node ABI). Default provider is **mock** (no API keys needed).

## Architecture

Everything is a **task**. When you type a goal and hit Run:
1. A **root task** is created
2. A **manager task** (`kind=planner`) creates the canonical worker plan
3. Typed **worker tasks** (`scout`, `implementer`, `reviewer`, `verifier`, `summarizer`) execute with structured packets and artifacts
4. Implementers bootstrap into git/local branches, then best-effort Docker runtimes, and verifier/summarizer follow-ups consume worker artifacts

All tasks share the same UI: a tree in the sidebar, chat-style event detail with operator messaging on the right.

## Layout

- `electron/` — main process, preload, IPC wiring
- `frontend/` — React UI (Vite + Tailwind)
- `backend/` — orchestrator, DB, tools, providers, workspace helpers
- `backend/db/rootTaskFacade.ts` — unified task API wrapping internal tables
- `shared/ipc.ts` — IPC channel constants and action types
- `AGENTS.md` — short repo contract for Grist agents
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
| `getSkillsCatalog` | List bundled + installed skills |
| `installSkill` | Install a skill globally or for the current repo |
| `removeSkill` | Remove an installed skill |

## CLI

```bash
node dist-electron/grist-cli.js run --repo /path/to/repo --goal "your goal"
node dist-electron/grist-cli.js list            # list all root tasks
node dist-electron/grist-cli.js status <taskId>  # task + subtask statuses
node dist-electron/grist-cli.js watch <taskId>   # live tail events
node dist-electron/grist-cli.js skills available
node dist-electron/skills-cli.js list --scope global
```

## Skills

Grist supports Claude/Cursor-style skill packs:

- Bundled skills ship in `bundled-skills/`
- Global installs live in `~/.grist/skills/<skill-id>/`
- Project installs live in `<repo>/.grist/skills/<skill-id>/`
- Skills are Markdown packs centered on `SKILL.md` frontmatter, not executable plugins

Installed skills become visible to workers through the read-only tools `list_skills` and `read_skill`. The app exposes a **Skills** modal in the top bar for browsing bundled skills and installing/removing them by scope.

## Recent improvements

- **Typed swarm roles**: manager/scout/implementer/reviewer/verifier/summarizer contracts with structured artifacts
- **Manager-owned planning**: planner writes a canonical `manager_plan` artifact and only parallelizes independent work
- **Git-first execution**: Grist initializes non-git repos and creates an initial snapshot before isolated worktrees need a `HEAD`
- **Best-effort Docker bootstrap**: implementers/verifiers try to start standalone Docker runtimes with per-task ports and fall back to host execution with a structured warning
- **Isolated implementer branches/worktrees**: implementers now get dedicated local branches and worktrees instead of sharing one checkout
- **Verifier follow-ups**: completed implementers automatically fan into verifier tasks
- **Parallel greenfield planning**: Empty repos get shared-contract setup plus file-owned module tasks
- **Retry on model errors**: Workers retry LLM/parse errors up to 3× with backoff
- **Git diff captures new files**: Uses `git add -A` + `--cached` diff to include untracked files
- **Expanded allowlist**: Common dev commands (npm, node, python, git, curl, etc.) + wrapper support (timeout, pipes)
- **Memory system**: `write_memory`/`read_memory` tools + async post-task reflection
- **Skill system**: bundled/global/project skill packs, top-bar Skills modal, CLI `skills` entrypoint, runtime `list_skills` / `read_skill`
- **Compaction preserves file list**: "Files written" entry survives context compaction

## Spec

See `docs/AGENT_HANDOFF.md` for architecture details and contracts.
