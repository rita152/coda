---
status: accepted
---

# Version the linear Session Record schema

Session v1 begins with an explicit versioned header and appends typed Records with stable identity, monotonic Session sequence, and `previousRecordId`. The name deliberately commits only to a linear predecessor, not a future tree model.

Session v4 adds `composer_submission_recorded` and `composer_submission_retracted`. A Composer Submission is recorded when interactive model-directed input is accepted, before later Agent consumption; this preserves Prompt History ordering without pretending it is Message ordering. Retraction removes a reclaimed, unconsumed Follow-up from the history projection without rewriting the journal. Legacy User Messages before the first v4 Composer fact are projected as history entries during migration.

Session v5 adds `permission_audit_recorded` facts for effective Permission configurations, approval decisions, rule persistence, warnings, and Sandbox execution outcomes. These facts are deliberately excluded from the restored Session projection: a cold resume recomputes authority from the new process configuration and never restores transient profiles, grants, or Session approvals from the journal.

Session v6 adds ordered Extension References to Composer Submission facts and a separate `permission_selected` fact. ADR-0035 supersedes only the earlier blanket exclusion of a selected high-level Permission Profile; Permission audit facts and concrete authority remain non-restoring.

Semantic Run, Attempt, Message, Tool, Follow-up, Composer Submission, Model, and Project Trust facts are durable. Streaming, rendering, approval UI, active process state, and every User Shell command/output remain transient. Accepted Steering may appear in Prompt History but is never restored into an Agent queue.
