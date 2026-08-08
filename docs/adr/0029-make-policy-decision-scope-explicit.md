---
status: accepted
---

# Make Policy Decision scope explicit

Interactive policy returns `allow_once`, `allow_run`, `deny`, or `deny_and_abort` only after displaying the canonical operation, reason, scope, and host-authority implications. Outside-Workspace grants remain exact and one-shot, Run grants are operation-class-specific, no permanent allow exists initially, and non-interactive execution fails closed unless CLI Policy already grants the operation.
