---
Status: implemented
---

# Session Titles

`/session` shows a model-generated Session Title instead of the first Prompt.

Historical implementation record. Current behavior is defined by `docs/adr/0054-generate-durable-session-titles.md`, Session v11 in `docs/adr/0024-version-the-linear-session-records.md`, and the `coding-agent.sessions` capability.

## Requirements

- After the first Prompt, generate a short title with the Session's current Model.
- Persist the title as a Session Record. Later `/session` listings use that title.
- OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages share one generation path.
- If generation fails or has not finished, fall back to the first Prompt or `New session`.
- Title generation is not part of the Agent transcript and does not use Tools.

## Seams

- `generateSessionTitle` / `ensureSessionTitle` — public title generation
- `summarizeSessionRecords` / `summarizeSessionMessages` — `/session` projection
- `session_title_set` Session Record — durable title
