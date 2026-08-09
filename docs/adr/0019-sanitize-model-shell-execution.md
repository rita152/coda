---
status: superseded by ADR-0034
---

# Sanitize model-generated Shell execution

The model-invoked Shell runs non-interactively from the Workspace with a minimal environment, explicit secret allowlisting, a default timeout, process-group termination, bounded model-visible output, and no managed background jobs. Shell network and host authority are not falsely presented as sandboxed, and non-interactive use requires explicit permission rather than an approval prompt.

This decision applies to the model-invoked `bash` Tool. Interactive User Shell mode is a separate explicit-authority path: a leading `!` is the user's direct request, so it bypasses Tool Policy Gate, inherits the full environment, uses the login Shell, and never enters model Context. It still uses process-group termination and a terminal-sanitized bounded output pipeline, but keeps no overflow file or Session record.
