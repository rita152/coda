---
status: accepted
---

# Separate Editor, Composer, and input queue control

`@coda/tui` owns an application-neutral Editor that hides grapheme editing, visual wrapping, paste folding, undo, and cursor placement behind text/input/render methods. `@coda/coding-agent` composes that Editor into the Composer and owns Reasoning-level styling, Attachments, sent-Prompt cards, Steering and Follow-up commands, and footer policy. A separate InputQueueController coordinates media preparation, Agent queue mutation, serialized Session facts, compensation, resume, and reclaim.

Agent owns queue execution and the synchronous pre-Run preparation seam, but it does not know terminal presentation or persistence records. Session v3 persists queue lifecycle facts, including `follow_up_reclaimed`, while Paused and failed UI states remain projections rather than mutable journal status. This keeps text mechanics reusable, presentation policy local to the Coding Agent, and crash-safe queue choreography out of Chat event handling.
