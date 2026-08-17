---
Status: resolved
Type: task
---

# Persist generated Session Titles

Implement Codex-style Session Titles for `/session` across OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages.

## Comments

Landed Session v11 `session_title_set` plus a Tool-less side `complete()` after the first Prompt. `/session` and `coda sessions` project the generated title, falling back to the first Prompt when generation fails.

Live OpenCode Go verification (2026-08-17), first Prompt: implement a bilingual `/session` picker that shows generated titles:

- `anthropic-messages` / `minimax-m3` → `Session Picker Bilingual Title Display`
- `openai-completions` / `hy3` → `Bilingual session picker with generated titles`
- `openai-responses` / `gpt-5.6-luna` → `Implement bilingual /session picker with generated session titles`

Each listing title was a short summary, not the raw first Prompt, and the journal contained `session_title_set`.
