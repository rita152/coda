# Add Work Graph delegation

Status: resolved
Blocked by: 02, 03, 04

Add the bounded `delegate` Tool described in `../spec.md`. Bind it to the invoking Work Graph and parent Work Item, support nested delegation, reuse the graph concurrency and cancellation controls, wait without holding a Workspace mutation lease, and return bounded structured Work Results rather than child transcript scraping.

## Comments

- Added one coordinator-owned `delegate` Tool only to write-capable Workers. Its schema contains bounded child specifications only; graph, parent, Runtime, and Session identities are closure-bound and cannot be supplied by the model.
- Delegation submits `AddWorkItems` through the same public command path, waits on durable child Work Results, supports nested delegation, and returns a bounded structured projection rather than reading child transcripts.
- A delegating parent releases its graph/process execution slot while waiting and reacquires it deterministically in accepted source order. The Tool bypasses Workspace tool binding, so it holds no Direct Workspace mutation lease.
- Verified nested root/child/grandchild delegation with both concurrency caps set to one, cancellation cascade during delegation wait, source-order results, unique Workers/Sessions, durable accepted batches, private identity exclusion, and result truncation bounds (18 focused tests passing).
