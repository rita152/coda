# Make WorkGraphFact and WorkGraphAggregate authoritative

Status: resolved

Implement the closed durable fact algebra and pure reducer described in `../spec.md`.

Required outcomes:

- one versioned `WorkGraphFact` union covers every durable Graph and Item transition;
- no critical lifecycle Result, Publication, acceptance, or recovery record is an unvalidated `JsonValue` payload;
- live mutation and replay use the same reducer;
- invalid state combinations and invalid transition order are rejected deterministically;
- mutable Worker Runtime, Session, Placement, AbortController, Promise, and teardown handles stay outside aggregate state;
- codecs validate exact keys and bounded identities in Runtime, not in the filesystem Adapter;
- replay/property tests compare live reduction with encoded/decoded replay;
- replaced recovery mutation code and redundant tests are deleted where integration permits.

Concentrate work in new Runtime domain Modules and tests. If full Coordinator integration would overlap heavily with the other tasks, leave a small, explicit integration note rather than adding a compatibility layer.

## Comments

- Added the Runtime-owned v1 `WorkGraphFact` algebra with exact semantic codecs and the immutable `WorkGraphAggregate`; live `apply` and decoded `replay` share the same reducer and reject malformed or out-of-order facts before mutation.
- Added exhaustive codec/lifecycle/recovery coverage plus 64 generated replay histories; `@coda/runtime` check, build, and all 97 tests pass.
- Integration note: final P0 integration should replace the legacy `WorkJournalRecord`/Coordinator restore mutations with per-Graph encoded facts and one aggregate per active Graph, deleting those old paths. That cutover is intentionally left to tasks 01/04 ownership; no compatibility adapter was added.
