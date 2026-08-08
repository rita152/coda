---
status: accepted
---

# Prepare the in-memory Agent for replay

The first `@coda/agent` remains an in-memory runtime based on the mature Pi Agent behavior, but uses stable message identities, immutable event payloads, explicit capabilities, and persistence seams so later restore and replay do not depend on object identity. Incomplete Harness actions, durable operations, session repositories, and compaction remain outside the first implementation even when their design informs the seams.
