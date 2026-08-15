# Separate observation completeness from open failures

Type: bug
Status: resolved
Priority: P1

Version the Tool evidence semantics so deliberate pagination, recoverable overflow, lossy overflow, historical failures, and currently open failures are distinct. Replace the misleading unresolved accumulator with deterministic resolution keys while retaining backward-readable history.

## Acceptance

- `read(offset > 1)`/limit pagination is `windowed` and does not create a Tool issue, while previous/more-page facts remain accurate.
- User preview, recoverable overflow, and lossy overflow have distinct categories and counts.
- A failed edit/read followed by success for the same Tool and exact target can close the open failure; unrelated success cannot.
- A failed verification command closes only after the same normalized command succeeds.
- Historical and open failures coexist, with correct omission counts and an explicit compatibility/version strategy.
- Evidence presentation and summary consumers stop presenting normal pagination as an anomaly.

## Ownership

Own `packages/coding-agent/src/run-evidence/*`, `tools/read.ts`, and focused tests. Expose a generic public projection for issues 01 and 05. Do not encode product-specific completion policy inside evidence collection.

## Comments

Resolved in `fa97346`: Run Evidence now separates completeness from open, recovered, and historical failures and treats ordinary pagination as a window rather than an anomaly.
