---
status: accepted
---

# Version the linear Session Record schema

Session v1 begins with an explicit versioned header and appends typed Records with stable identity, monotonic Session sequence, and `previousRecordId`. The name deliberately commits only to a linear predecessor, not a future tree model.

Session v4 adds `composer_submission_recorded` and `composer_submission_retracted`. A Composer Submission is recorded when interactive model-directed input is accepted, before later Agent consumption; this preserves Prompt History ordering without pretending it is Message ordering. Retraction removes a reclaimed, unconsumed Follow-up from the history projection without rewriting the journal. Legacy User Messages before the first v4 Composer fact are projected as history entries during migration.

Session v6 adds ordered Extension References to Composer Submission facts.

Session v11 adds `session_title_set`. A Session Title is recorded when a side Model call produces a sanitized label for the Session picker; it does not rewrite earlier Prompts or enter the Agent transcript.

Semantic Run, Attempt, Message, Tool, Follow-up, Composer Submission, Model, Project Trust, and Session Title facts are durable. Streaming, rendering, active process state, and every User Shell command/output remain transient. Accepted Steering may appear in Prompt History but is never restored into an Agent queue.
