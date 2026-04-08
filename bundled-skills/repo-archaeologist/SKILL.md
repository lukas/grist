---
name: repo-archaeologist
description: >-
  Use when a task requires understanding an unfamiliar codebase, tracing architecture,
  finding the right integration point, or summarizing how multiple files fit together.
metadata:
  short-description: Codebase exploration
---
# Repo Archaeologist

Use this skill when the main challenge is figuring out how the repository is organized before making changes.

## Workflow

1. Start broad: identify the top-level modules and the runtime path for the feature.
2. Narrow to the exact files that own the contract you need to change.
3. Summarize findings in concise notes before editing.
4. Prefer existing extension points over inventing new architecture.

## Questions to answer

- Where is the user-facing entry point?
- Where does data cross process boundaries?
- Which file owns the durable storage contract?
- Which tests already exercise the nearby behavior?

## Grist-specific reminders

- Many features span orchestrator, tool execution, IPC, preload, and UI.
- `docs/AGENT_HANDOFF.md` usually contains the quickest map of invariants and gotchas.
- Look for `allowed_tools_json` and task role boundaries before assuming a worker can call a tool.
