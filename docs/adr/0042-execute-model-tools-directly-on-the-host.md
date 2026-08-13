---
status: accepted
---

# Execute model Tools directly on the host

Coda executes built-in File Tools, Shell commands, search helpers, mutation workers, and background processes directly as the current host user. Relative paths still resolve from the Workspace, Shell and background processes inherit the complete Coda process environment, output remains bounded, and file mutations retain atomic write and race-detection guarantees; none of those data-integrity boundaries restrict which host resources a model-requested operation may access. This deliberately replaces the former internal authority and operating-system confinement architecture because that subsystem was no longer trustworthy, and keeping partial compatibility surfaces would falsely imply protection that the runtime does not provide.
