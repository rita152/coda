# Anthropic Messages adapter

Type: task
Status: resolved

Implement the lazy Anthropic Messages adapter using `@anthropic-ai/sdk@0.91.1`, SDK retries disabled, and mock streaming contracts.

## Acceptance

- SSE text, thinking, partial Tool JSON, terminal detail, cancellation, authentication, and unknown-event contracts pass offline.

## Comments

- Resolution evidence (2026-08-08): `packages/ai/test/anthropic-messages.test.ts` covers text, thinking, partial Tool JSON, terminal details, cancellation, authentication, and unknown mock SSE events.
