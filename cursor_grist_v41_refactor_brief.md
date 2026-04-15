# Cursor Implementation Brief: Refactor Grist Toward v4.1 Simplicity-First Scheduler

You are modifying Grist to implement a **simple, lightweight, contract-driven swarm execution model**.

Your goal is **not** to add more agent complexity.
Your goal is to make Grist:

- default to the smallest swarm that works
- use episodes as the core execution unit
- keep the scheduler thin
- keep contracts as the source of truth
- let the user intervene at any layer
- treat memory as advisory
- use conservative parallelism

This brief is intended as an implementation guide, not a brainstorming prompt.
Prefer direct, minimal changes over architectural sprawl.

---

## Product Intent

Grist should feel like:

> a fast, inspectable, contract-driven build system powered by LLMs

It should **not** feel like:

> a large autonomous multi-agent framework with many interacting subsystems

### Design priorities

In order:

1. correctness
2. debuggability
3. efficiency
4. user control
5. parallelism
6. autonomy

If a change increases complexity without a clear improvement in those priorities, do not make it.

---

## Target Mental Model

### Core entities

- **Job** = one top-level user request
- **Plan** = decomposition of a job into one or more episodes
- **Episode** = the smallest debuggable execution unit
- **Task** = one concrete runnable step inside an episode

### Episode lifecycle

The primary execution loop should be:

```text
implementer -> verifier_local -> optional repair loop -> optional reflection -> passed
```

Episodes are the main thing the scheduler launches, tracks, retries, and exposes to the user.

---

## High-Level Changes to Make

Implement the following changes.

### 1. Make the scheduler thin

The scheduler should be a **state machine + decision engine** only.

It should:
- read current state
- decide the next action
- enqueue work
- persist state transitions

It should **not** directly perform interpretation-heavy work.

Move these responsibilities out of scheduler logic if they currently live there:

- memory ranking / selection
- contract violation classification
- reflection content generation
- discovery-event interpretation beyond simple routing
- any LLM reasoning beyond deciding which task to launch next

Create or use helper services/modules for:
- memory context assembly
- runtime contract enforcement
- event processing
- reflection

### 2. Default to single-agent execution

Planning should have an explicit default bias toward **one implementer**.

Only split into multiple episodes when there is a clear benefit:
- clearly disjoint file ownership
- meaningful wall-clock savings
- reduced risk through decomposition

If decomposition confidence is low, collapse to one episode.

### 3. Treat contracts as the source of truth

Every episode must have a `contract_json` with at least:

```json
{
  "inputs": [],
  "outputs": [],
  "file_ownership": [],
  "acceptance_criteria": [],
  "non_goals": []
}
```

Enforce these rules:

- implementers may not silently expand scope
- downstream tasks may only depend on declared outputs
- plan validation must reject dependency/output mismatches
- runtime must detect writes outside `file_ownership`

### 4. Make contract violations deterministic

Do not leave contract-violation handling ambiguous.

Implement a simple deterministic classifier:

- **minor violation**: touched extra file, but still within same narrow feature area
- **major violation**: touched cross-boundary file, forbidden area, or shared/global config area

Required behavior:
- minor violation -> record artifact/warning, continue to verifier
- major violation -> mark episode invalid and trigger replan

Do not rely on a later LLM pass to decide this.

### 5. Keep discovery events as hints only

Discovery events may:
- annotate future queued work
- write scratchpad entries
- trigger replanning

Discovery events may **not**:
- directly modify contracts
- directly modify dependencies
- silently change obligations of already-defined tasks

Contracts remain the only source of truth.

### 6. Make memory advisory and lightweight

Memory should be:
- read-heavy
- write-light
- injected at task launch
- never treated as authoritative

The scheduler should call a memory service, not assemble memory itself.

Use conservative limits:
- planner memory notes max: 5
- worker memory notes max: 3

Reflection may propose durable memory writes, but ordinary workers should not directly persist memory without a reflection/wrap-up gate.

### 7. Keep reflection local to episodes

Reflection is optional and asynchronous.

It should:
- run after a local verifier pass
- write memory only when warranted
- not create a job-level orchestration phase

Keep reflection as an **episode-level phase**, not a top-level job state.

### 8. Allow user intervention at every layer

The user must be able to intervene at:

- **plan level**: approve, edit decomposition, force single-agent, force parallel
- **episode level**: retry, pause, cancel, accept despite warning
- **task level**: edit contract or scope before execution, defer edits if already running
- **code level**: patch files, rerun verification, request new episode from modified baseline

### 9. Validate user-injected episodes

User-injected episodes are allowed, but must pass the same validation as planner-created episodes.

If a user-injected episode conflicts with the existing plan:
- do not silently graft it in
- trigger replan or reject with a clear validation error

### 10. Make parallelism conservative

Parallelism is allowed only when episodes are clearly independent.

Default policy:
- if uncertain, do not parallelize

Never run overlapping writers in parallel.

---

## Required Invariants

Add a small “system invariants” section in code comments or docs and implement accordingly.

1. Contracts are the only source of truth.
2. Scheduler decides; helper services interpret.
3. Memory is advisory, never authoritative.
4. Episodes are the unit of execution and debugging.
5. Discovery events cannot modify contracts.
6. User edits either validate cleanly or trigger replanning.
7. Parallelism is conservative by default.

---

## Concrete Implementation Tasks

Please make the following concrete changes in the codebase.

### A. Scheduler refactor

Refactor scheduler code so it is responsible only for:
- selecting runnable jobs
- processing job state
- launching ready episodes
- polling running tasks
- triggering replans
- triggering integration verification
- triggering summarization
- finalizing terminal state

Move logic like:
- memory selection
- reflection artifact generation
- contract violation classification
into helper modules/services.

If there is already a scheduler module, keep the public surface small and readable.

### B. Episode-centric execution

Make sure episodes are the primary execution abstraction.

Required behavior:
- one implementer task per episode attempt
- local verifier after every successful implementer
- repair loop stays within the episode
- episode becomes `passed` only after verifier success and optional reflection completion

### C. Plan validation

Strengthen plan validation to enforce:
- every episode has contract + file ownership
- hard conflicts are rejected
- dependency/output compatibility is checked at plan time
- unclear decompositions are collapsed to single-agent when possible

### D. Contract enforcement

Implement runtime detection of files touched outside `file_ownership`.

Persist:
- artifact of type `contract_violation`
- structured metadata about violating files
- severity classification

Then:
- continue on minor
- replan on major

### E. Memory service

Create or cleanly separate a memory service with an interface like:

```python
get_planner_context(job) -> dict
get_worker_context(job, episode) -> dict
get_repair_context(job, episode) -> dict
maybe_persist_reflection(job, episode, verifier_result) -> None
```

The scheduler should depend on that interface, not on memory internals.

### F. Event processor

Create or cleanly separate discovery-event processing.

Allowed effects:
- annotate queued episodes
- write scratchpad entries
- request replan

Disallowed effects:
- mutate existing contracts directly

### G. User intervention handling

Make sure interventions are explicit, validated, and auditable.

For user-injected episodes:
- validate against current plan
- either add safely or trigger replan

### H. Reflection simplification

Keep reflection quality-gated.
Good triggers for reflection:
- repair chain happened
- contract violation happened
- non-trivial multi-file change happened

Skip reflection for trivial clean single-file tasks.

Reflection should not create a separate global orchestration stage.

### I. Replan simplification

Centralize replan decisions behind one function, something like:

```python
should_replan(context) -> bool
```

It should consider:
- repair exhausted
- major contract violation
- integration failure
- budget exhaustion
- dependency mismatch

Avoid scattering replan policy across many unrelated branches.

### J. Config defaults

Use conservative defaults:

```python
MAX_PARALLEL_WORKERS = 4
MAX_REPAIR_ATTEMPTS = 2
REPAIR_REPLAN_THRESHOLD = 0.6
JOB_REPLAN_THRESHOLD = 0.8
MAX_REPLANS_PER_JOB = 2
MAX_INTEGRATION_REPLANS = 1
MAX_MEMORY_NOTES_FOR_PLANNER = 5
MAX_MEMORY_NOTES_FOR_WORKER = 3
DEFAULT_MODE = "single_agent_bias"
INTEGRATION_VERIFY_ON_MULTI_EPISODE = True
```

---

## Preferred Architecture Shape

Target something like:

```text
scheduler/
  loop.py
  decisions.py
  transitions.py

services/
  memory_service.py
  contract_service.py
  event_service.py
  reflection_service.py

execution/
  implementer_runner.py
  verifier_runner.py
  integration_runner.py

models/
  jobs.py
  episodes.py
  tasks.py
  artifacts.py
  events.py
  user_actions.py
```

Do not force this exact layout if the repo has an existing structure, but move in this direction:
- thin scheduler
- explicit services
- episode-centric execution

---

## State Model Expectations

### Job states

Keep job states simple:

- `created`
- `planning`
- `ready`
- `running`
- `waiting_for_user`
- `verifying_integration`
- `summarizing`
- `completed`
- `completed_with_warnings`
- `failed_delivery`
- `blocked`
- `timed_out`
- `aborted`

Do **not** add a top-level `reflecting` job state.

### Episode states

Episodes may include:

- `queued`
- `ready`
- `running`
- `verifying`
- `repairing`
- `reflecting`
- `passed`
- `failed`
- `blocked`
- `timed_out`
- `aborted`

---

## Acceptance Criteria

This refactor is complete when all of the following are true:

1. The scheduler reads clearly as a thin control loop.
2. Memory assembly is not embedded in scheduler logic.
3. Contract violations are detected and classified deterministically.
4. Discovery events cannot silently change task obligations.
5. User-injected episodes are validated before launch.
6. Parallelism remains conservative by default.
7. Reflection is episode-local and optional.
8. The system still supports user intervention at plan, episode, task, and code level.
9. Replan policy is centralized and easy to inspect.
10. The resulting code is simpler to reason about than before.

---

## Implementation Guidance

When editing code:

- preserve existing working paths where possible
- avoid broad rewrites unless necessary
- prefer incremental refactors with clear seams
- keep comments short and operational
- delete dead or redundant logic if this refactor makes it obsolete

If there are tradeoffs, choose:
- simpler control flow
- fewer implicit behaviors
- more explicit validation
- less orchestration magic

---

## Output Requested

Please implement the refactor directly in the codebase.

As you work:

1. identify the current scheduler / orchestration files
2. refactor toward the design above
3. add or update helper services as needed
4. update state transitions and validation logic
5. remove or simplify logic that violates the v4.1 principles
6. summarize the changes made at the end

Do not just describe the changes. Make them.
