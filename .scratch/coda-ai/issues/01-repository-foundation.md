# Repository foundation

Type: task
Status: resolved

Create the private npm workspace, `@coda/ai@0.1.0`, strict NodeNext TypeScript, Biome, Vitest, and offline build/check/test/pack orchestration described by the confirmed spec.

## Acceptance

- Root scripts orchestrate only existing packages.
- Both root and package remain private.
- Imports are ESM-only and side-effect-free.
- A deliberately failing public-seam test precedes implementation.

## Comments

- Resolution evidence (2026-08-08): root/package manifests, strict TypeScript and Biome configuration, and `packages/ai/test/root-exports.test.ts` verify the private ESM workspace foundation.
