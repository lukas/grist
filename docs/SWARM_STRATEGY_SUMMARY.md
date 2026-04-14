# Grist Swarm Strategy Summary

## Purpose

This document summarizes how Grist decomposes work into tasks/subtasks, how parallelism is chosen, and how parent/child task relationships are tracked. It is intended for outside review of the orchestration strategy.

## Execution Model

Grist uses a typed task tree stored in SQLite.

- `root`: user-facing top-level task for one run
- `manager` (`kind=planner`): creates the canonical worker plan
- worker roles:
  - `scout`: read-only reconnaissance
  - `implementer`: writes code in an isolated branch/worktree
  - `reviewer`: read-only review
  - `verifier`: validates an implementation
  - `summarizer`: produces final handoff

Each task row records:

- `id`, `job_id`, `parent_task_id`
- `kind`, `role`, `status`
- `scope_json` packet
- branch/worktree/runtime metadata
- tool allowlist, budget, blocker state

## Planning Strategy

The manager is the only component that creates the canonical initial plan.

Planning rules:

- prefer plan-first, then execution
- parallelize only independent work
- avoid multiple implementers touching overlapping files
- keep packets small and explicit
- append a summarizer if the plan omitted one
- writable work uses isolated local branches/worktrees
- implementers automatically trigger verifier follow-ups
- failed verifiers can trigger automatic repair implementers on the same worktree
- passing verifiers can trigger one wrap-up implementer for cleanup/docs/PR/memory work
- manager-planned verifier tasks are dropped when implementers already imply automatic verifier follow-ups
- empty repos default to one writer unless independence is explicit, because isolated worktrees do not share unmerged code
- job completion is gated on the latest relevant verifier outcome, not just task terminal status

Worker packets are passed through `scope_json` and typically include:

- `files`
- `area`
- `acceptance_criteria`
- `non_goals`
- `similar_patterns`
- `constraints`
- `commands_allowed`
- `success_criteria`

## Parallelism

Parallelism is capped globally by the scheduler.

- max parallel workers: `4`
- `root` and `planner` are not schedulable worker slots
- queued tasks become `ready` when dependencies are satisfied
- ready tasks launch in priority order

Parallelism policy:

- read-only work may run in parallel when independent
- implementers only run in parallel when file ownership is disjoint
- if overlapping implementers are detected, planner validation merges them into one implementer task
- for greenfield repos, planner validation collapses multiple implementers into one writer by default

## Subtask Tracking

There are two ways new child tasks appear:

1. Manager-created worker tasks during planning
2. Orchestrator-created follow-up tasks during execution

Current automatic follow-up:

- successful `implementer` -> child `verifier`
- failed `verifier` -> child `implementer` repair task (capped retry depth)
- passed `verifier` for non-wrap-up work -> child `implementer` wrap-up task

Tracking is relational, not prompt-local:

- every child has `parent_task_id`
- scheduler uses `dependencies_json` to unblock dependent tasks
- UI renders a task tree from persisted parent/child links
- artifacts are linked back to the producing task via `task_id`

## Workspace Strategy

For writable code work, Grist prefers:

1. ensure repo is in git
2. ensure a usable `HEAD` commit exists
3. create a local branch and isolated worktree per implementer
4. best-effort start a task runtime (Docker when possible)
5. run commands against that runtime when supported
6. if verification passes, sync changed source files back into the canonical repo

Persisted per-task metadata includes:

- `git_branch`
- `base_ref`
- `worktree_path`
- `runtime_json`

## Failure / Recovery Strategy

The system distinguishes core delivery from auxiliary failures.

Current recovery behavior:

- verifier with no usable worktree is skipped with a warning artifact instead of hard-failing
- verifier failure can keep the job alive by spawning a repair implementer instead of ending the run immediately
- successful verification can still continue the run with a wrap-up pass for cleanup, docs, PR prep, and memory writing
- if the latest relevant verifier still fails after the repair chain, the run now fails instead of incorrectly completing
- summarizer tries schema-guided parse, then repair, then a fallback summary artifact
- final job status becomes `completed` with a warning event when only soft-failure tasks fail after core delivery succeeded

Soft-failure roles after successful implementation:

- `verifier`
- `summarizer`
- in some implementation-success cases, read-only scout/reviewer failures are treated as warnings

Critical failures:

- failed implementer tasks
- failed analysis-only runs with no successful delivery path

## Observed Trade-offs

Strengths:

- explicit typed roles
- durable task/artifact/event history
- isolated writable workspaces
- clear dependency-based scheduling
- good operator inspectability

Current weaknesses / review questions:

- whether automatic verifier follow-ups should fully replace planned verifiers
- whether the task tree should collapse or group auxiliary tasks more aggressively
- whether job status should expose `completed_with_warnings` as a first-class state instead of an event on top of `completed`
- whether summarization should be optional when worker artifacts already provide enough handoff
- whether future code-sharing/merge support should re-enable productive multi-writer greenfield plans
