# OpenCode Go model catalog

Type: task
Status: resolved

Commit the stable OpenCode Go snapshot and implement an explicit, fail-closed `models:update` generator with provenance, validation, atomic replacement, and readable diffs.

## Acceptance

- Ordinary build is offline.
- Unknown Api routing and partial refresh fail without modifying the old snapshot.
- The six contract sentinels and full retained catalog match the reviewed snapshot.

## Comments

- Resolution evidence (2026-08-08): the committed OpenCode Go snapshot and manifest are exercised by `model-generator.test.ts` and `opencode-go-models.test.ts`, including atomic failure and routing validation.
