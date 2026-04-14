# Grist Agent Contract

Read this before changing Grist orchestration, prompts, or task execution.

## What Grist Is

Grist is a local macOS Electron app for supervising coding agents against a git repo.

Execution model:
- `root` task: user-facing entrypoint
- `manager` task (`kind=planner`): canonical plan owner
- worker roles: `scout`, `implementer`, `reviewer`, `verifier`, `summarizer`

## Core Swarm Rules

- Use a manager-worker swarm, not a democracy.
- The manager owns the canonical plan, accepted assumptions, task status, and final handoff.
- Only parallelize independent work.
- Never fan out multiple implementers onto overlapping files.
- Workers return structured artifacts, not freeform essays.
- Give each worker only the files, constraints, and commands it needs.

## Role Contract

`manager`
- Creates the typed worker plan in `backend/orchestrator/planner.ts`
- Emits `manager_plan` artifact

`scout`
- Read-only reconnaissance
- Artifact: `findings_report`

`implementer`
- Writes code in an isolated worktree on its own local git branch
- Must stay inside scoped files when provided
- Artifact: `candidate_patch`

`reviewer`
- Read-only regression/style/API review
- Artifact: `review_report`

`verifier`
- Runs tests/typechecks/validation against an implementer result
- Artifact: `verification_result`

`summarizer`
- Compresses worker artifacts into the final handoff
- Artifact: `final_summary`

## Important Files

- `backend/orchestrator/planner.ts`: manager prompt, plan schema, role-aware fanout
- `backend/orchestrator/appOrchestrator.ts`: scheduler startup, worktree provisioning, verifier follow-ups
- `backend/runtime/taskRuntime.ts`: best-effort Docker detection, port allocation, startup, cleanup
- `backend/orchestrator/workerRunner.ts`: worker prompt packets, tool loop, artifact enforcement
- `backend/orchestrator/reducer.ts`: summarizer pass
- `backend/orchestrator/verifier.ts`: verifier pass
- `backend/types/taskState.ts`: plan schema and artifact contracts
- `backend/types/models.ts`: role and artifact enums
- `docs/AGENT_HANDOFF.md`: deeper architecture and gotchas
- `docs/SWARM_STRATEGY_SUMMARY.md`: concise explanation for outside reviewers

## Commands

```bash
npm run typecheck
npm test
npm run test:electron-smoke
npm run dev
```

## Conventions

- Prefer plan-first, code-second.
- For code-writing tasks, bootstrap in this order when possible: git repo -> branch/worktree -> Docker runtime -> worker loop.
- Docker bootstrap is best effort. If no safe runtime strategy is detected or startup fails, continue in the worktree and record the failure in task events/runtime metadata.
- Use GitHub-issue-style worker packets:
  - objective
  - exact files
  - acceptance criteria
  - non-goals
  - similar patterns
  - constraints
  - allowed commands
- Keep prompts and schemas aligned. If you change one, update the other.
- If you change durable orchestration behavior, update this file and `docs/AGENT_HANDOFF.md`.

## Forbidden Patterns

- Unscoped parallel implementer tasks
- Freeform worker summaries without artifacts
- Sharing one checkout across multiple implementers when isolated worktrees are expected
- Letting a writable subtask reuse the parent implementer worktree by default
- Dumping large raw logs into every worker prompt

## Done Means

- Manager plan is schema-valid
- Worker roles/artifact types are consistent
- Implementers use isolated worktrees and local branches
- Runtime metadata is persisted on the task row and cleaned up on stop/quit
- Verifier/summarizer failures should degrade gracefully when core implementation delivery already succeeded
- Validation commands still pass
- Docs reflect the current orchestration model
