---
status: accepted
---

# Separate Editor, Composer, and input queue control

`@coda/tui` owns an application-neutral Editor that hides grapheme editing, visual wrapping, paste folding, undo, and cursor placement behind text/input/render methods. Its application-neutral seams include visual-row boundary queries, opaque exact-state capture/restore, an absorbable text prefix, and border presentation. `@coda/coding-agent` composes that Editor into the Composer and owns Reasoning-level styling, Attachments, Prompt History, Shell mode, sent-input cards, queue commands, and footer policy.

ComposerHistory is a pure state machine over durable Composer Submissions. It decides whether Up/Down may replace Editor text only after the Editor reports a visual boundary, and it owns exact draft restoration without owning Attachments or rendering another component.

InputQueueController coordinates media preparation, Agent mutation, User Shell execution, serialized Session facts, compensation, pause, resume, and reclaim. Agent automatic Follow-up draining is disabled only for the interactive application so this controller can preserve one process-local FIFO across durable Follow-ups and transient User Shell commands; Steering still enters the active Run immediately. Agent remains unaware of terminal presentation, local Shell entries, and persistence records. Chat only projects state and forwards accepted intent.

Session v4 persists Follow-up lifecycle and Composer Submission facts. Paused and failed states remain projections. User Shell commands and their output are intentionally excluded from Session, Agent Seed, model Context, and Prompt History.
