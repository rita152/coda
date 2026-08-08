# OpenAI Responses adapter

Type: task
Status: resolved

Implement the lazy OpenAI Responses adapter using `openai@6.26.0`, SDK retries disabled, and mock streaming contracts.

## Acceptance

- Completed, incomplete, failed, missing-terminal, Tool-call, cancellation, authentication, and request retry contracts pass offline.

## Comments

- Resolution evidence (2026-08-08): `packages/ai/test/openai-responses.test.ts` covers completed, incomplete, failed, missing-terminal, Tool-call, cancellation, authentication, and request retry contracts offline.
