# Make WorkGraphFact and WorkGraphAggregate authoritative

Status: ready-for-agent

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

