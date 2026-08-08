# Core runtime

Type: task
Status: resolved

Implement EventStream, Assistant Message aggregation, structured Diagnostics, Tool argument validation, and the deterministic Faux Provider through public seams.

## Acceptance

- Terminal, ordering, cancellation, Tool-call, and invariant-deviation contracts pass.
- Error Messages retain Pi-compatible shape plus persistence-safe Diagnostics.

## Comments

- Resolution evidence (2026-08-08): EventStream, stream-contract, Faux Provider, Tool validation, cancellation, diagnostic, and injected-runtime behavior are covered by the corresponding `packages/ai/test/*.test.ts` suites.
