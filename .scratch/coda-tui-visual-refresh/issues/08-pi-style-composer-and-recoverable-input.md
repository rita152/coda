# Add the Pi-style Composer and recoverable input queues

Type: task
Status: resolved
Blocked by: 02, 03, 06, 07

Replace the append-only Chat input with a generic multiline Editor, use matching horizontal-border User Prompt cards, and connect Steering and durable Follow-up behavior through an application-owned InputQueueController.

## Acceptance

- Editor supports grapheme-safe editing, visual wrapping/navigation, multiline submission, paste folding, undo, kill/yank, height capping, and native/software cursor placement.
- Composer and sent User Prompt cards use full-width top and bottom borders without labels or side borders.
- Enter, Shift+Enter, Alt+Enter, empty Enter, and Alt+Up implement Prompt, newline, Follow-up, queue resume, and reclaim without stealing Timeline scroll keys.
- Abort and failure pause pending Follow-ups; paused and failed items survive resume with Attachments and can be edited and re-sent.
- Session v3 adds a reclaim tombstone and serializes all record appends; each queued Run receives a fresh Prompt/context preparation.
- Unit, strict-screen, Session migration/recovery, and macOS PTY tests cover the public seams.

## Answer

Implemented `Editor` in `@coda/tui`, composed it through `ChatComponent`, added `InteractiveInputController`, explicit Agent pause/resume and pre-Run preparation, Session v3 recovery projection, restored media indexing, capability-aware cursor/color behavior, two-row Attachment overflow, and PTY coverage for sent Prompt cards and multiline editing.

## Comments

The Editor remains application-neutral. Autocomplete, selection, redo, and durable unsent drafts remain deferred; they must not be added to Chat's queue/persistence state machine by extending the Editor surface ad hoc.
