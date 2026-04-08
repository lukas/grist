---
name: frontend-debugger
description: >-
  Use when a task involves browser UI bugs, broken interactions, missing state wiring,
  rendering issues, or Electron/Vite frontend regressions.
metadata:
  short-description: Frontend bug triage
---
# Frontend Debugger

Use this skill when the task is primarily about diagnosing or fixing frontend behavior.

## Workflow

1. Start by reading the current UI surface and the renderer-to-main contract.
2. Verify state flow before editing: component props, preload API, IPC handler, backend implementation.
3. Prefer narrow fixes that preserve existing interaction patterns.
4. Test the changed behavior with the lightest available check before claiming success.

## Common checks

- Renderer component state and event handlers
- `window.grist` preload exposure
- IPC constants and Electron handlers
- Recent repo selection, modal open/close, and optimistic UI refresh paths

## Grist-specific reminders

- UI contracts usually span `frontend/src`, `electron/preload.ts`, `shared/ipc.ts`, and `electron/main.ts`.
- If a feature appears in the UI but does nothing, check preload and IPC wiring before changing backend logic.
- Keep settings and modal UIs small and inspectable.
