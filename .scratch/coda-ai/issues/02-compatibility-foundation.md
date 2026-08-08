# Compatibility foundation

Type: task
Status: resolved

Add the versioned machine compatibility manifest, selected Pi-compatible type closure, explicit export map, compile consumers, runtime import audit, and deliberate-deviation tests.

## Acceptance

- Every selected export or subpath is classified and tied to a test.
- Export-map tests reject accidental public paths.
- Tests never read the desktop Pi checkout.

## Comments

- Resolution evidence (2026-08-08): `packages/ai/compatibility/manifest.v1.json`, `packages/ai/test/public-types.test.ts`, and `packages/ai/test/exports-manifest.test.ts` enforce the selected compatibility surface without reading Pi at test time.
