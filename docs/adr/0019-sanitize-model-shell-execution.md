---
status: accepted
---

# Sanitize model-generated Shell execution

The model-invoked Shell runs non-interactively from the Workspace with a minimal environment, explicit secret allowlisting, a default timeout, process-group termination, bounded model-visible output, and no managed background jobs. Shell network and host authority are not falsely presented as sandboxed, and non-interactive use requires explicit permission rather than an approval prompt.
