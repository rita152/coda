---
status: accepted
---

# Identify operations and snapshot Agent events

Every Run, Turn, Message, Tool Invocation, and queued input has an Agent-owned opaque identity allocated before work begins, and each Run emits a monotonic event sequence. Listeners receive immutable deltas or completed snapshots rather than references shared with mutable assembly state, allowing later validation, restore, and replay without inheriting Pi's object-identity coupling.
