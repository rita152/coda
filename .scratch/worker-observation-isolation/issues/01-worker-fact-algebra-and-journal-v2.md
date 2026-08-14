# Define the Worker Fact algebra and Work Journal v2

Status: resolved

## Objective

Create the exhaustive event router, narrowly typed Session and Worker Control event sets, bounded Worker Fact algebra, shared live/recovery reducer, and v2 Work Journal codec described by the spec.

Delete `worker_event` and reject v1 journals explicitly. Do not add a compatibility decoder.

## Scope

- Worker protocol and Work Journal types in `@coda/runtime`.
- Pure event routing and Worker Fact reduction modules.
- `FileWorkJournal` v2 encoding/decoding.
- Recovery projection and existing journal fixtures/tests.
- Compile-time and runtime guards that prohibit transient/full-fidelity payloads in Worker Facts.

## Acceptance

- Every event has the exact disposition in the spec matrix.
- Live and recovery counters/open-effect windows use one reducer.
- Journal records are bounded and contain no Agent event payloads.
- v1 input fails with an actionable unsupported-version error.
- Focused tests pass and obsolete `worker_event` expectations are removed.

## Comments

- Implemented a closed, exact-key-validated Worker Fact algebra, the exhaustive pure Agent-event router, narrow Session/Control unions, and one immutable reducer shared by live accounting and recovery. `run_started` now performs the first `preparing -> running` projection without a second journal sync.
- Replaced the Work Journal record with `worker_fact`, upgraded the file envelope to v2, added bounded Fact codec guards, and made complete v1 input fail with `Unsupported Work Journal version 1; this build requires version 2`; no decoder or migration remains.
- Replaced preparation/full-event journal assertions with Observation and Fact contracts, including a complete routing matrix, 10,000 delta + 10,000 progress classifications, parallel open-window reduction, forbidden-payload checks, and v2 file round trips.
- Verification: `npm run check --workspace=@coda/runtime` passed; `npm test --workspace=@coda/runtime` passed (66 tests before the focused Fact suite was added); `npx vitest run test/worker-fact.test.ts` passed (4 tests); `npx vitest run test/file-work-journal.test.ts` in `packages/coding-agent` passed (7 tests).
