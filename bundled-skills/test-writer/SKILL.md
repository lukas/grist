---
name: test-writer
description: >-
  Use when a change needs focused automated coverage, especially for regressions in
  backend helpers, CLI behavior, prompt shaping, or tool dispatch.
metadata:
  short-description: Focused regression tests
---
# Test Writer

Use this skill to add high-value tests without flooding the repo with low-signal cases.

## Principles

1. Prefer focused tests around the changed contract.
2. Reuse existing test style and helpers near the code you are changing.
3. Avoid snapshot-heavy or implementation-detail assertions when a behavior assertion is enough.
4. If runtime verification already gives strong confidence, keep tests minimal.

## Good targets

- CLI parsing and output for new commands
- Tool execution behavior and permission checks
- Parsing helpers and filesystem-backed managers
- IPC contract edge cases that are easy to regress

## Grist-specific reminders

- `backend/tools/*.test.ts` is the best home for tool-surface tests.
- CLI helpers are easier to test than full process spawning.
- When adding a new repo-local feature under `.grist`, use temp dirs and env overrides in tests.
