---
status: accepted
---

# Retry failed Attempts only before Tool execution

The generic Agent exposes an injected, default-disabled Turn retry policy; the Coding Agent enables up to three transient-error retries with 2s, 4s, and 8s delays. Each retry is a distinct Attempt in the same Turn, and automatic retry is forbidden after any Tool from the response starts, or for auth, billing/quota, validation, context-overflow, or caller-abort outcomes.
