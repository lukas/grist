# Grist Improvement Ideas

All items from the 2026-04-08 CLI test run have been implemented. This file tracks future ideas.

## Implemented (2026-04-08)
- Stall escalation tiers (warn 30s → auto-pause 5min → fail 15min)
- "Thinking" state during LLM calls (prevents false stalls)
- Retry with doubled maxTokens on truncation
- CLI built as part of `npm run build:electron`
- Event ordering fixed to chronological (ASC)
- Planner splits multi-component projects into parallel tasks

## Future ideas
- Integration test between parallel tasks (e.g. verify imports work across modules)
- Smarter task dependency inference (cli_interface depends_on game_logic + ai_engine)
- Streaming LLM responses to reduce perceived latency
- Cost budgets per task with automatic stopping
