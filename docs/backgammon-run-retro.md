# Backgammon CLI Build — Retrospective

**Date:** 2026-04-15
**Goal:** Build a CLI-based backgammon game in TypeScript via `grist run`

## Run 1: Before fixes

**Outcome:** Failed (worker crash at step 34), game partially playable
**Cost:** $0.26, 258K tokens, ~5 min wall clock

### Timeline
1. Planner fell back to default (scout + implementer + summarizer) due to JSON parse error
2. Scout finished in 2 steps (empty repo)
3. Implementer hit **scope enforcement bug**: `**/*` treated as literal, not glob — all writes rejected
4. **Supervisor correctly caught the loop** and injected redirect advice
5. **Auto-pause** triggered after 3 identical `read_file` calls
6. After resume: rewrote everything, got 3/7 tests passing
7. **Worker crashed** at step 34: `TypeError: Cannot read properties of undefined (reading 'trim')`

### Result: TS compiles, game playable (PvP/PvE, ASCII board, dice, doubles, bar), 3/7 tests pass

### Bugs found and fixed
- **Scope glob bug** in `patchTools.ts`: `**/*` wasn't treated as "allow all" → added `matchesGlob()`
- **CLI `message` command**: `insertEvent` not imported → added import
- **Worker crash handling**: unhandled exception kills entire worker promise → added `runTaskWorkerSafe` wrapper
- **`run_command_safe` null guard**: `args.command` could be undefined → added type check

---

## Run 2: After fixes

**Outcome:** Paused (token budget exceeded at step 26), game compiles, 31/39 tests pass
**Cost:** $0.20, 202K tokens, ~2 min wall clock

### Timeline
1. Planner tried 4 tasks, collapsed to 1 (contract validation — dependency reference)
2. **Step 3: Excellent.** Wrote 15 files in a single parallel `call_tools` (all source + tests + config + README)
3. **Step 4:** `npm install` + `npm test` in parallel
4. **Step 12:** TypeScript compiles after one fix cycle
5. Steps 13-26: Agent spent remaining budget reading test files to understand failures. Used `cat` via `run_command_safe` to paginate through large files instead of using `read_file`.
6. Hit 200K token budget at step 26, paused.

### Result: TS compiles, 31/39 tests pass, game has welcome screen + mode select, but runtime error (`require` in ESM context)

---

## Comparison: Run 1 vs Run 2

| Metric | Run 1 | Run 2 | Improvement |
|---|---|---|---|
| Wall clock | 5 min | 2 min | 60% faster |
| Tokens | 258K | 202K | 22% less |
| Tests passing | 3/7 | 31/39 | 4x more |
| TS compiles | Yes | Yes | Same |
| Worker crash | Yes | No | Fixed |
| Scope bug | Blocked all writes | N/A | Fixed |
| Game runnable | Partially | Partially (ESM issue) | Similar |

---

## What worked well (relative to README vision)

| Vision principle | Evidence |
|---|---|
| **Parallel tool calls** | Step 3 in Run 2: 15 files written in a single call. Step 4: install + test in parallel. |
| **Supervisor** | Correctly caught scope-enforcement loop in Run 1 and injected actionable redirect. |
| **Auto-pause** | Prevented infinite read loops. Caught 3x identical calls. |
| **Episode shape** | Scout → implementer flow correct; verifier would spawn if implementer finished. |
| **Isolated worktrees** | All work in isolated worktree, canonical repo untouched until verification. |
| **Budget controls** | Budget extension on resume (+13 steps, +50K tokens). Token budget cap worked. |
| **Crash handling (Run 2)** | `runTaskWorkerSafe` prevented unhandled crash propagation. |

## What didn't match the vision

### 1. No task-level parallelism
Both runs collapsed to a single implementer. The greenfield collapse logic blocks parallel implementers even when components are independent. Fix applied: allow sequential chains via `depends_on`.

### 2. Agent never used `ask_user`
Despite enhanced prompt guidance ("if you've tried 2+ times, ask the user"), the agent never asked. The LLM may need even stronger prompt scaffolding or examples. Consider adding few-shot examples of `ask_user` to the prompt.

### 3. Agent never used `run_command_bg`
Tests were always run synchronously via `run_command_safe`. The agent never tried to run tests in background while doing other work. Prompt guidance exists but the agent doesn't follow it.

### 4. Agent never used `spawn_subtask`
The implementer never decomposed its work. For a game with clearly separable game logic, AI, and CLI, spawning subtasks would have been ideal.

### 5. Context window burn
The biggest issue in Run 2: the agent read `rules.ts` (a large file) 5+ times, burning ~100K tokens on redundant reads. The compaction system should kick in more aggressively, and the agent should be guided to not re-read files it already has in context.

### 6. No best-of-N attempted
The planner never emitted `speculative_approaches`. Could have tried "all-in-one-file" vs "multi-module" approach.

### 7. No memory persisted
Neither run reached the wrap-up phase, so no memory was written. Even on failure/budget-exceeded, some memory should be persisted.

---

## Fixes applied during this session

1. **`matchesGlob()` in `patchTools.ts`** — glob pattern matching for file scope enforcement
2. **`insertEvent` import in CLI** — fixed `message` and `respond` commands
3. **`runTaskWorkerSafe` wrapper** — catches unhandled errors, marks task as failed gracefully
4. **Null guard in `toolRunCommandSafe`/`toolRunCommandBg`** — prevents crash on undefined command
5. **Greenfield collapse relaxation** — allows sequential `depends_on` chains for multi-implementer greenfield plans
6. **Planner prompt update** — explains sequential greenfield chains as an option
7. **Worker prompt hardening** — stronger guidance for `ask_user` on repeated failures, no re-reading files, background commands for tests

## Remaining gaps (ordered by impact)

1. **Agent doesn't follow `ask_user` guidance** — may need few-shot examples or a decision-space expansion
2. **Agent doesn't use `run_command_bg`** — may need to auto-suggest it when test suites exist
3. **Context window burn** — need earlier compaction or "read once" enforcement
4. **No failure memory** — need pre-wrapup memory writes on budget-exceeded or crash
5. **Planner still collapses** — the LLM planner itself needs to output valid `depends_on` chains; fallback logic is too aggressive
6. **`read_file` with undefined path** — agent sends bad args 3x per run, need a guard in `toolReadFile`
