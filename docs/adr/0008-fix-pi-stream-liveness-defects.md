---
status: accepted
---

# Fix Pi stream liveness and cancellation defects

Coda deliberately deviates from Pi where missing authentication can synchronously throw on direct adapter paths, setup-time cancellation is mislabeled as an error, or an incomplete `EventStream.end()` can leave `result()` pending forever. All public streaming paths produce terminal failures consistently, an aborted caller signal yields `aborted` in every phase, and ending without a result produces an explicit invariant failure rather than a hang.
