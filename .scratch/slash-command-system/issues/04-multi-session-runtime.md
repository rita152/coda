# Add the multi-Session Runtime manager

Type: task
Status: resolved
Blocked by: 01, 02

Refactor the interactive application around a workspace-scoped Session Runtime Manager so `/session` changes focus while other live Sessions continue in the background, and `/new` creates a draft Session.

## Acceptance

- Running and queued work continue after focus changes.
- Background interactive requests become `needs attention` without stealing focus.
- Historical pending Follow-ups restore paused.
- Empty `/new` is idempotent and Draft Sessions materialize lazily.
- Runtime close and CLI shutdown follow the confirmed cancellation and discard semantics.
- The Session browser provides current-workspace summaries and live status.

## Answer

Implemented workspace-scoped live Runtime switching, concurrent background Runs and Follow-ups, deferred background approvals with `needs attention`, process-local lazy Draft Sessions, current-workspace browsing, empty `/new` idempotence, and whole-process cancellation/discard on CLI exit.
