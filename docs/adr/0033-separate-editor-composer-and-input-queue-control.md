---
status: accepted
---

# Separate Editor, Composer, and input queue control

ADR-0044 replaces direct per-Agent input mutation with the public Work Item
command seam. The application-owned Composer and mixed-queue policy below
remain accepted and now live in `InteractiveInputController`.

`@coda/tui` owns an application-neutral Editor that hides grapheme editing, visual wrapping, paste folding, undo, and cursor placement behind text/input/render methods. Its application-neutral seams include visual-row boundary queries, opaque exact-state capture/restore, an absorbable text prefix, and border presentation. `@coda/coding-agent` composes that Editor into the Composer and owns Reasoning-level styling, Attachments, Prompt History, Shell mode, sent-input cards, queue commands, and footer policy.

ComposerHistory is a pure state machine over durable Composer Submissions. It decides whether Up/Down may replace Editor text only after the Editor reports a visual boundary, and it owns exact draft restoration without owning Attachments or rendering another component.

`InteractiveInputController` coordinates media preparation, public Work Item
command delivery, User Shell execution, application Session facts,
compensation, pause, resume, and reclaim. It preserves one process-local FIFO
across durable Follow-ups and transient User Shell commands; Steering still
enters active Work immediately. Agent remains unaware of terminal presentation,
local Shell entries, and persistence records. Chat only projects state and
forwards accepted intent.

Session format v4 introduced Follow-up lifecycle and Composer Submission facts;
later formats retain them. Paused and failed states remain projections. User
Shell commands and their output are intentionally excluded from Session, Agent
Seed, model Context, and Prompt History.
