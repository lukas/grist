# Grist

Local **macOS Electron** app to supervise a typed manager-worker swarm against a **git repo**: one manager, a thin scheduler, contract-scoped workers, structured artifacts, git-first bootstrap, selective best-effort Docker runtimes with managed ports, isolated local branches/worktrees, and verifier-driven episode follow-ups.

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
4. Implementers/verifiers form the main episode loop: implementer -> verifier -> optional repair -> optional reflection -> wrap-up

All tasks share the same UI: an episode-first tree in the sidebar, chat-style event detail with operator messaging on the right, and an episode flow strip for switching between implement/verify/repair/wrap-up phases.

## Layout

- `electron/` — main process, preload, IPC wiring
- `frontend/` — React UI (Vite + Tailwind)
- `backend/` — orchestrator, DB, tools, providers, workspace helpers
- `backend/db/rootTaskFacade.ts` — unified task API wrapping internal tables
- `shared/ipc.ts` — IPC channel constants and action types
- `AGENTS.md` — short repo contract for Grist agents
- `docs/AGENT_HANDOFF.md` — architecture + contracts for agents
- `docs/SWARM_STRATEGY_SUMMARY.md` — concise external-review summary of task/subtask strategy

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
- **Thin scheduler + helper services**: scheduler now delegates dependency/terminal decisions, memory assembly, contract checks, and reflection to dedicated helpers instead of interpreting them inline
- **Explicit episode contracts**: worker packets now include `contract_json` (`inputs`, `outputs`, `file_ownership`, `acceptance_criteria`, `non_goals`) and plan validation rejects dependency/output mismatches
- **Git-first execution**: Grist initializes non-git repos and creates an initial snapshot before isolated worktrees need a `HEAD`
- **Best-effort Docker bootstrap**: implementers/verifiers try to start standalone Docker runtimes with per-task ports and fall back to host execution with a structured warning; CLI-style Node apps no longer auto-start a misleading `npm start` container just because they have a `start` script
- **Isolated implementer branches/worktrees**: implementers now get dedicated local branches and worktrees instead of sharing one checkout
- **Verifier follow-ups**: completed implementers automatically fan into verifier tasks
- **Verifier-driven repair**: failed verification can automatically spawn a repair implementer on the same worktree instead of ending the run
- **Post-verify wrap-up**: passing verification can now trigger one final wrap-up implementer to clean code, update docs, prepare a PR, and write durable memory notes
- **Episode-first UI/API**: `getChildTasks` now returns derived episode metadata so the sidebar/detail views can surface episode roots, aggregate episode status, current phase, attempt number, and episode flow explicitly
- **Safer greenfield planning**: Empty repos now default to one writer owning bootstrap + integration because isolated worktrees do not share unmerged code
- **Deterministic contract enforcement**: out-of-scope implementer writes now persist `contract_violation` artifacts; minor same-area drift continues, major cross-boundary drift triggers replan
- **Verified apply-back**: when verification passes, Grist copies the changed source files back into the canonical repo and skips transient outputs like `node_modules` and `dist`
- **Verifier-gated completion**: a run no longer finishes while the latest relevant verifier in a repair chain is still failing
- **Retry on model errors**: Workers retry LLM/parse errors up to 3× with backoff
- **Git diff captures new files**: Uses `git add -A` + `--cached` diff to include untracked files
- **Expanded allowlist**: Common dev commands (npm, node, python, git, curl, etc.) + safer wrapper/chaining support for benign multi-command probes like `pwd && ls -la`, while still rejecting redirects and mixed dangerous chains
- **Memory system**: planner/worker prompts now get lightweight advisory memory via `memoryService`, and durable writes are reserved for wrap-up/reflection instead of arbitrary worker steps
- **Skill system**: bundled/global/project skill packs, top-bar Skills modal, CLI `skills` entrypoint, runtime `list_skills` / `read_skill`
- **Compaction preserves file list**: "Files written" entry survives context compaction
- **Worktree-aware repo tools**: implementer reads/lists/greps now operate against the isolated worktree, not the canonical repo checkout
- **Wrap-up git/PR commands**: default safe-command allowlist now includes the git/`gh` subset needed for PR-oriented wrap-up passes
- **Verifier fallback checks**: verifiers now choose from available `test`, `build`, and startup-smoke commands instead of always defaulting to `npm test`, and they do not fail solely because a CLI project lacks a test script
- **Runtime command normalization**: runtime-backed safe commands now strip redundant `cd /workspace && ...` prefixes before allowlist/execution
- **Cleaner blocker hovers**: task-tree `!` badges use only the custom tooltip now, avoiding the duplicate native browser hover bubble

## Spec

See `docs/AGENT_HANDOFF.md` for architecture details and contracts, and `docs/SWARM_STRATEGY_SUMMARY.md` for a shorter outside-review summary of the swarm/task strategy.
