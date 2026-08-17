---
status: accepted
---

# Generate durable Session Titles

`/session` used the first Prompt as the Session label. That text is often a long instruction, not a findable name. Codex-style pickers prefer an explicit or generated title and only fall back to the first user line.

Coda now asks the Session's current Model for a short title after the first Prompt, persists it as a `session_title_set` Session Record, and projects that title into Session summaries. Generation is a side `complete()` call with no Tools: OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages share the same prompt and sanitizer. Failure keeps the first-Prompt fallback. The call is not part of the Agent transcript.
