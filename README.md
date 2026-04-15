# Grist

## Vision

Grist is a lightweight, extensible environment where many agents work in parallel and the user can interact with them at every level.

**Parallelism everywhere.** The user works on many things at once and so should the agents. A single goal—"build a calendar chat app"—might spawn one agent to integrate Google Calendar, another for iMessage, another for WhatsApp, all running concurrently. Agents should trade tokens for wall-clock time: run long commands as background subtasks, try two approaches in parallel and pick the better one, spin up Docker containers for isolation. Wasting some tokens to save human time is the right trade-off.

**Rich human interaction.** Every agent can talk to the user. If an agent has a question it should ask; if a supervisor notices looping it should intervene. The user should be able to redirect, fork, or message any agent at any depth in the tree.

**Hierarchical context and memory.** Agents inherit context from their parents and grandparents so they don't waste tokens re-discovering what's already known. When an agent learns something useful—about the current task, the project, or the user—it can push that knowledge up the parent stack into persistent memory.

**Multi-machine, container-first.** When Docker is available agents should use containers for isolation and parallelism. If the user provides access to multiple machines, work should distribute across them.

**Minimal framework, maximum extensibility.** No unnecessary abstractions. The core is a typed task tree, a thin scheduler, structured contracts, and a set of tools. Everything else—roles, skills, runtimes—is layered on top without framework lock-in.

---

## Gap analysis: current state vs. vision

| Capability | Vision | Status | Implementation |
|---|---|---|---|
| **Parallel workers** | Unbounded, resource-aware | ✅ Done | Dynamic scaling via `parallelism.ts`: computes max workers from CPU cores, free memory, and urgency setting (low/normal/high/max). Adapts every scheduler tick. |
| **Best-of-N / speculative execution** | Try multiple approaches, pick the best | ✅ Done | Planner can emit `speculative_approaches` on a task. `bestOfN.ts` spawns N competing implementers, each verified independently. Verifier scores select the winner; losers are superseded. |
| **Long-running commands as subtasks** | Tests/builds run in background, agent continues thinking | ✅ Done | `run_command_bg` starts a command in background (10min default timeout), returns a `command_id`. `poll_command` checks status and returns truncated output. |
| **Agent-initiated questions** | Structured questions with options | ✅ Done | `ask_user` tool/decision: agent emits question + options, task pauses. UI renders options as clickable buttons. User's answer is injected via the existing message mechanism. |
| **Supervisor / anti-loop agent** | LLM-powered trajectory review | ✅ Done | `supervisor.ts` runs every 60s per job. Reviews running workers' recent events via the planner model. Verdicts: continue, warn, redirect (injects advice as operator message), or pause. |
| **Sub-agent spawning by workers** | Workers decompose their own work | ✅ Done | `spawn_subtask` creates up to 3 parallel child implementers with isolated worktrees. `poll_subtask` checks completion and retrieves artifacts. Subtasks cannot recursively spawn. |
| **Multi-machine distribution** | Use multiple machines when offered | ✅ Foundation | `workerPool.ts`: register SSH-based remote workers, health-check, run remote commands, rsync file sync. Dynamic parallelism includes remote slots. Scheduler dispatch to remotes is a future step. |
| **Hierarchical context inheritance** | Child agents see parent/grandparent context | Partial | Children get `scope_json`, dependency artifacts, inherited worktrees. Memory service provides keyword-ranked notes. Gap: no parent conversation summary injection; no sibling broadcast. |
| **Memory propagation up the stack** | Task → project → global memory | Partial | Advisory memory via `memoryService`. Writes gated to wrap-up/reflection. Gap: no explicit "push finding to parent" mechanism; no user-preference tier. |
| **Docker-first isolation** | Containers as default for all writable work | Partial | Best-effort Docker with host fallback. Gap: containers should be default, host should be explicit opt-out. |
| **Token-for-time trading** | Aggressively parallel | ✅ Done | Urgency knob (low/normal/high/max) scales worker count. Best-of-N for speculative execution. Async commands for background test/build. Subtask spawning for decomposition. |

### What's working well

- **Episode-shaped execution** (implement → verify → repair → reflect → wrap-up) is solid and self-healing.
- **Contract enforcement** catches scope drift deterministically and triggers replans for major violations.
- **Operator interaction** at every level: message any task, ask_user for structured questions, pause/resume/redirect/fork, rich task-tree UI.
- **Git-first isolation** with per-implementer worktrees and verified apply-back.
- **Memory system** with advisory injection, keyword ranking, and reflection-gated writes.
- **Thin scheduler** delegates decisions to helper services; dynamic parallelism adapts to system resources.
- **Supervisor** catches loops and wasted work via periodic LLM trajectory review.
- **Async execution** lets agents start long commands in the background and continue reasoning.

### Remaining gaps (ordered by impact)

1. **Parent conversation summary injection** — children should see a compact digest of their parent's reasoning.
2. **Sibling broadcast** — parallel workers should be able to share discoveries in real time.
3. **Docker-default isolation** — containers should be opt-out, not opt-in.
4. **Remote task dispatch** — the worker pool exists but the scheduler doesn't yet route tasks to remote machines.
5. **User-preference memory tier** — persistent memory about the user's preferences (coding style, preferred tools, etc.).

---

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
- **`ask_user` tool**: agents can ask the operator structured questions with clickable option buttons; the task pauses and resumes when the user answers
- **Async command execution**: `run_command_bg` starts a command in the background (10min default timeout), `poll_command` checks status and returns output — agents can continue reasoning while tests/builds run
- **Best-of-N speculative execution**: planner can emit `speculative_approaches` for a task; the orchestrator spawns N competing implementations, verifies each, and picks the winner based on verifier scores
- **Supervisor agent**: LLM-powered trajectory reviewer runs every 60s, inspects running workers' recent events, and can warn, redirect (inject advice as operator message), or pause stuck/looping agents
- **Worker-initiated subtasks**: implementers can call `spawn_subtask` to decompose complex work into up to 3 parallel child tasks with isolated worktrees, and `poll_subtask` to check completion and collect artifacts
- **Dynamic parallelism**: `MAX_PARALLEL_WORKERS` is now computed dynamically from CPU cores, free memory, urgency setting (low/normal/high/max), and registered remote worker slots
- **Multi-machine worker pool**: `workerPool.ts` provides SSH-based remote worker registration, health checks, remote command execution, and rsync file sync; remote slots are included in the dynamic parallelism calculation

## Spec

See `docs/AGENT_HANDOFF.md` for architecture details and contracts, and `docs/SWARM_STRATEGY_SUMMARY.md` for a shorter outside-review summary of the swarm/task strategy.
