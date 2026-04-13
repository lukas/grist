# Grist — agent handoff

## What this repo is

**Grist** is a macOS Electron app for **supervising** a small typed manager-worker swarm on a **local git repo**: manager planner → scheduler (≤4 workers) → verifier/summarizer follow-ups, with git-first bootstrap and best-effort standalone Docker runtimes for code work. v0 prioritizes inspectability and operator control, not autonomy.

## Run / build

```bash
cd grist
npm install
npm test
npm run build          # dist-electron + dist-frontend
npm run dev            # Vite :5173 + Electron (needs display)
npm run test:electron-smoke   # build + Electron-only check for window.grist
```

**Tests:** `npm test` runs Vitest (including `preloadBundle.test.ts`: CJS preload shape). `npm run test:electron-smoke` runs `electron/smoke.cjs` (expect `SMOKE_OK`).

**Native module:** `better-sqlite3` must match the Node ABI. `npm run dev` / `npm start` run `electron-rebuild -f -w better-sqlite3`. `npm test` runs `npm rebuild better-sqlite3` first (Vitest uses system Node, not Electron).

### Paths

- **DB:** `app.getPath('userData')/grist.sqlite`
- **Logs:** `<repo>/.grist/logs/job-N/task-N.jsonl`
- **Global skills:** `~/.grist/skills/<skill-id>/SKILL.md`
- **Project skills:** `<repo>/.grist/skills/<skill-id>/SKILL.md`
- **Scratch/worktrees:** `userData/workspace/jobs/<jobId>/…`
- **Per-task runtime state:** persisted on the `tasks.runtime_json` column
- **Schema file:** copied to `dist-electron/schema.sql` on electron build
- **Bundled skills:** copied to `dist-electron/bundled-skills/`; source lives in `bundled-skills/`

## Architecture map

### Unified task model

Everything is a **task**. The old "jobs" table is kept internally but hidden behind `rootTaskFacade.ts`.

| Concept | Description |
|---------|-------------|
| **Root task** | Top-level task created by user (`kind=root`). The only entity the frontend sees. |
| **Manager task** | `kind=planner`, role `manager`, child of root. Owns the canonical worker plan and emits `manager_plan`. |
| **Worker tasks** | Typed roles: `scout`, `implementer`, `reviewer`, `verifier`, `summarizer`. |
| **Artifacts** | Structured handoffs written per role: findings, candidate patch, review report, verification result, final summary. |
| **Runtime** | Best-effort Docker bootstrap for implementers/verifiers with per-task port metadata and host fallback. |

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
| Tools | `backend/tools/executeTool.ts`, `memoryTools.ts`, `controlTools.ts` |
| Git/runtime bootstrap | `backend/workspace/gitRepoManager.ts`, `backend/runtime/taskRuntime.ts` |
| Memory | `backend/memory/memoryManager.ts` — `~/.grist/` (global) + `<repo>/.grist/` (project) |
| Skills | `backend/skills/skillManager.ts`, `backend/tools/skillTools.ts`, `cli/skillsCliCore.ts` |
| Reflection | `backend/orchestrator/reflection.ts` — async post-task learning distillation |
| React UI | `frontend/src/App.tsx`, `frontend/src/components/*` (incl. `MemoryDrawer`, `MemoryViewer`, `SkillsModal`) |

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
| `sendTaskMessage` | Inject operator message into a running task's event stream |
| `getSkillsCatalog` | List bundled + installed skills |
| `installSkill` | Install a skill into global or project scope |
| `removeSkill` | Remove an installed skill |
| `readSkill` | Read installed skill contents |
| `repoDefaults` / `createRepo` | Return the default repo parent (`~/grist-repos`) and create a named git repo there or in a custom parent folder |

### Frontend components

| Component | Behavior |
|-----------|----------|
| `App.tsx` | State: `rootTaskId`, `selectedTaskId`. Uses `createTask`/`startTask` to run. |
| `MissionControl` | Header bar. Repo picker, provider dot, Skills button, pause/resume/stop via `rootTaskControl`. Repo dropdown includes `New repo…` and `Browse…`. |
| `TaskList` | Left sidebar. Root tasks as expandable nodes, child tasks as tree. Filters out `root`/`planner` kinds. Task blocker `!` now shows an explicit hover tooltip with the issue text. |
| `TaskDetail` | Main panel. Chat-style event view with operator message input. Loads events via `getEventsForTask(taskId)`. |
| `SkillsModal` | Browse bundled skills, install/remove global + project skills. |

## Contracts / invariants

- **Root task facade** — `rootTaskFacade.ts` wraps `insertJob` + `insertTask(kind='root')`. Root task ID is the only ID the frontend uses. `rootTaskToJobId()` resolves internally.
- **Manager is a real task** — `planner.ts` inserts `kind=planner`, `role=manager` as child of root. The manager emits a schema-validated `manager_plan` artifact and all planner events attach to that task.
- **Typed worker roles** — `task.role` is now a first-class contract (`scout`, `implementer`, `reviewer`, `verifier`, `summarizer`) instead of an arbitrary label. `backend/types/taskState.ts` holds the plan schema plus role-specific artifact contracts.
- **Structured worker packets** — the manager sends scoped packets (`files`, `acceptance_criteria`, `non_goals`, `similar_patterns`, `constraints`, `commands_allowed`, `success_criteria`) through `scope_json`. `workerRunner.ts` turns those into role-specific prompts.
- **Provider propagation** — CLI `create-task` now passes planner/reducer/verifier providers from `loadAppSettings()`, not just the default worker provider.
- **Scheduler skips root/planner** — `NON_SCHEDULABLE_KINDS = {root, planner}`.
- **Implementers get isolated worktrees** — `appOrchestrator.ts` provisions a dedicated worktree before an `implementer` starts. The worker loop no longer falls back to writing directly into the shared repo for isolated-worktree tasks.
- **Git-first bootstrap** — backend task creation now tolerates non-git repos. Before a writable task needs a worktree, `gitRepoManager.ts` ensures the repo is initialized and, if necessary, creates an initial snapshot commit so worktree creation has a valid `HEAD`.
- **Local branch handoff** — per-task `git_branch` and `base_ref` are now persisted on the task row and surfaced through the CLI/UI metadata.
- **Best-effort Docker runtime** — `taskRuntime.ts` detects `docker compose`, common Node app dev flows, or a plain `Dockerfile`, allocates a per-task host port when needed, and records runtime state in `runtime_json`. Failures are warnings unless the task cannot proceed for some other reason.
- **Container-aware command execution** — `run_command_safe` / `run_tests` / `run_lint` prefer `docker exec` automatically when the task runtime supports it; otherwise they run on the host.
- **Cleanup on stop/quit** — task runtimes are torn down on task stop, job stop, worker completion, and app quit to reduce orphaned containers/ports.
- **Verifier follow-up is automatic** — when an `implementer` finishes successfully, `appOrchestrator.ts` spawns a `verifier` child task if one does not already exist.
- **Summarizer output** — reducer tasks now act as `summarizer` workers and emit `final_summary` artifacts instead of only reducer-local summaries.
- **Auto-pause** — 3× identical tool call, 5 consecutive errors, 3 empty tool names.
- **Stall detection** — debounced (one event per episode), escalation: warn@30s, pause@5min, fail@15min. Tasks in `current_action: "thinking"` are exempt.
- **Three-tier context compaction** (Claude Code / OpenHands inspired):
  - **Tier 1 — Observation masking** (always, free): truncate old tool results outside recent window (10 entries) to 200 chars with `[tool output truncated]` prefix. Keeps assistant reasoning + user messages intact.
  - **Tier 2 — LLM summarization** (conditional): when history exceeds 30 entries AND 120K chars, summarize old entries via same provider into a single context summary. Recent 10 entries kept in full.
  - **Tier 3 — Token-budget-aware**: triggers based on estimated token count. Compaction events emitted so UI can show when compaction occurs.
  - History is replaced in-place after summarization so subsequent steps use the compact version.
- **Skill system** — skills are declarative instruction packs, not executable plugins. Bundled skills live in `bundled-skills/`; installs copy them to `~/.grist/skills/` or `<repo>/.grist/skills/`. The worker prompt includes a compact installed-skill index from `buildSkillIndex()`, and tasks can explicitly call `list_skills` / `read_skill` to load full instructions. Project skills override same-id global skills for visibility.
- **Write scope is enforced** — `write_file` and `apply_patch` reject out-of-scope writes using `task.scope_json.files`. Planner/worker prompts now explicitly steer greenfield plans toward `architect -> parallel modules -> integrator` with one owner per file.
- **Parallelism is role-aware** — the manager merges parallel implementers when ownership is not independent and appends a summarizer task when missing.
- **Repo creation UX** — the renderer can open `CreateRepoDialog`, which asks for a repo name plus optional parent directory. Main process creates repos under `~/grist-repos/<name>` by default and runs `git init`.
- **Explicit resume extends budget** — manual resume paths (`taskControl enqueue`, `resume_all`) now increase `max_steps` and `max_tokens`, emit a `budget_extended` event, clear the blocker, and then requeue the task. There is still no parent-agent review loop for paused children.

## Provider env / settings

SQLite `settings` table **or** repo-root **`.env`** (gitignored). `loadAppSettings()` prefers DB (UI) values; `.env` is fallback only. Prefix: `GRIST_*`. Also accepts `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## CLI

```bash
node dist-electron/grist-cli.js <command>
```

Uses the unified task API. Key commands: `run`, `list`, `subtasks`, `status`, `summary`, `watch`, `pause`/`resume`/`stop`, plus `skills ...` for skill management. `cli/skills-cli.ts` builds a standalone `skills` entrypoint.

## Known gaps

- Command palette and open-in-editor not implemented.
- Reducer/verifier need real providers for useful output.
- `docker compose` runtimes currently prefer visibility over deep introspection: commands still fall back to the host unless the runtime supports direct exec.
- Schema migration (merge jobs into tasks table) is a future follow-up.
- The current UI still treats planner data mostly as task traces; a richer manager-plan/artifact panel would be a follow-up.
- See `docs/IMPROVEMENT_IDEAS.md` for future enhancement ideas.

## Implementation log

| Date | Change |
|------|--------|
| 2026-04-06 | Initial v0: Electron+Vite+React+Tailwind, SQLite, planner/scheduler/worker, tools, IPC UI. |
| 2026-04-08 | Unified task model: root task facade, planner as real task. |
| 2026-04-08 | Bug fixes: retry on model errors, stall dedup, job status reflects failed tasks, maxTokens 8K→16K. |
| 2026-04-08 | Frontend fully wired to unified task API. Removed all `jobId` references from renderer. Deleted orphaned components (EventStream, PatchComparison, GlobalFindings). |
| 2026-04-08 | Operator messaging: `sendTaskMessage` IPC inserts `user_message` events; `workerRunner` injects them into LLM history; `TaskDetail` shows chat input + styled message bubbles. |
| 2026-04-08 | Three-tier context compaction: Tier 1 observation masking (always), Tier 2 LLM summarization (>30 entries + >120K chars), Tier 3 token-budget-aware triggers. Token budgets 200K/100K. Budget messages show model/usage detail. Settings: DB overrides .env. |
| 2026-04-08 | Robustness: Planner prefers parallel tasks for greenfield (architect + fan-out with scope.files). max_steps→done when files written. depsSatisfied accepts done/completed/failed/stopped. Memory tools wired into executeTool. Git diff includes untracked files. Allowlist expanded + supports wrapper commands. Memory prompting during work. |
| 2026-04-08 | Restored skill system after unified-task refactor: runtime `list_skills` / `read_skill`, skill index in worker prompt, Skills modal in the header, IPC handlers, bundled-skill copying during build, and CLI `skills` entrypoints. |
| 2026-04-09 | Concurrency hardening: stronger planner-provider defaulting, CLI provider propagation on `create-task`, tool-layer `scope.files` enforcement, and greener fallback planning that separates architect/module/integrator ownership. |
| 2026-04-09 | Repo picker UX: added `New repo…` in the header dropdown plus a named-repo creation modal with default parent `~/grist-repos` and optional custom parent browsing. |
| 2026-04-09 | Task tree clarity: blocker `!` indicators now render an in-app hover tooltip that spells out the task issue instead of relying on a bare title attribute. |
| 2026-04-09 | Manual resume now grants extra step/token budget before requeueing paused tasks, so resume can continue a task instead of immediately hitting the same limit again. |
| 2026-04-13 | Typed swarm orchestration: manager task + `manager_plan`, role-specific worker packets/artifacts, isolated implementer worktrees, automatic verifier follow-ups, `AGENTS.md`, and `final_summary` summarizer output. |
| 2026-04-13 | Git-first Docker bootstrap: backend git init + initial snapshot fallback, persisted branch/runtime metadata, best-effort Docker runtimes with per-task ports, runtime-aware command execution, and cleanup on stop/quit. |
