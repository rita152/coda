# OpenAI Completions adapter

Type: task
Status: resolved

Implement the lazy OpenAI Chat Completions adapter using `openai@6.26.0`, SDK retries disabled, and mock streaming contracts.

## Acceptance

- Text, reasoning, Tool calls, terminal reasons, cancellation, authentication, and request retry contracts pass offline.

## Comments

- Resolution evidence (2026-08-08): `packages/ai/test/openai-completions.test.ts` exercises the lazy SDK adapter, mock protocol stream, cancellation, Tool calls, errors, and request retry behavior offline.
