---
status: superseded by ADR-0038
---

# Fail closed on context overflow

Until compaction is deliberately implemented, Coda rejects requests that definitely exceed the Model context window and maps provider-reported overflow to a non-retryable Diagnostic. It never silently truncates, drops, or summarizes Session history; interactive users may start a new empty Session, while print mode exits with failure.
