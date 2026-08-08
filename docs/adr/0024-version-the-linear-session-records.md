---
status: accepted
---

# Version the linear Session Record schema

Session v1 begins with an explicit versioned header and appends typed Records with stable identity, monotonic Session sequence, and `previousRecordId`. The name deliberately commits only to a linear predecessor, not a future tree model; semantic Run, Attempt, Message, Tool, Follow-up, Model, and Project Trust facts are durable while streaming, rendering, approval UI, Steering, and active process state are not.
