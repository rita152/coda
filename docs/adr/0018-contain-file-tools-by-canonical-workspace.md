---
status: superseded by ADR-0034
---

# Contain File Tools by canonical Workspace

File Tool authority defaults to a canonical Workspace realpath and is checked through symlinks, including at mutation commit. Outside access requires a one-operation Path Grant for an exact canonical target rather than a global bypass; sensitive paths remain approval-gated even inside the Workspace, while Policy diagnostics retain requested and resolved paths.
