# grV0 implementation checklist

Use this to verify the spec against the codebase. Checked items are implemented in v0.

## Product / scope

- [x] Electron macOS shell (dev loads Vite; prod loads `dist-frontend`)
- [x] React + TypeScript UI
- [x] Node/TS backend in Electron main (orchestrator + DB + tools)
- [x] SQLite persistence (`backend/db/schema.sql`)
- [x] Repo picker (`dialog.showOpenDialog`)
- [x] Goal + operator notes (notes stored on job, passed to workers/reducer)
- [x] Planner (template decomposition, 4 analysis + 1 reducer)
- [x] Scheduler (`backend/orchestrator/scheduler.ts`, max 4 parallel)
- [x] Worker loop with structured decision + one tool per step (`workerRunner.ts`)
- [x] Reducer (artifact + model synthesis)
- [x] Verifier (tests + model summary artifact)
- [x] Shared read-only repo for analysis; worktree for patch tasks
- [x] Per-task scratchpad files under app workspace
- [x] Artifact store (SQLite `artifacts`)
- [x] Git worktree for patch writer spawn path
- [x] Task list + DAG (deps) view toggle
- [x] Task detail panel
- [x] Global findings (reducer artifact panel)
- [x] Pause / stop / redirect / fork / reprioritize / enqueue controls
- [x] Provider abstraction + Claude / Codex / Kimi (OpenAI-compatible) / mock
- [x] Core tools: list_files, grep_code, read_file, read_git_history, list_changed_files, run_tests, run_lint, run_command_safe, create_worktree, write_file, apply_patch, get_worktree_diff, remove_worktree, scratchpad + artifact + progress + pause_self

## Nice to have

- [ ] Command palette
- [x] Basic DAG view (dependency JSON + task ids)
- [x] Patch comparison table (`PatchComparison.tsx`)
- [ ] Open file in editor
- [x] Open worktree in Finder (`shell.openPath`)

## Explicitly not built (per spec)

- [ ] Docker sandboxing
- [ ] Browser tools, semantic search, plugins, multi-user, cloud backend, polished auth

## Circuit breakers

- [x] Command timeout (default 60s tests / configurable)
- [x] Token budget per task → pause
- [x] Step budget per task → pause
- [x] Stall detection (>30s no `last_activity_at` while running → event + `stalled` flag)
- [x] Duplicate-work hint (3 identical tool signatures → warning event)

## Tests (automated)

- [x] `npm test` — scheduler deps + SQLite FK insert + command allowlist

## Acceptance criteria (manual in Electron)

1. [ ] Open app, pick repo, enter goal, run a job (mock provider works without API keys).
2. [ ] See parallel tasks (up to 4).
3. [ ] Inspect findings / scratchpad paths in UI.
4. [ ] Redirect a running task (goal update + event).
5. [ ] Reducer summary artifact after reducer task completes or “Summarize now”.
6. [ ] Spawn patch task → worktree created; optional verifier spawn.
7. [ ] Compare patch/verification rows in table.
