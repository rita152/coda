# Third-party notices

`@coda/coding-agent` studies Pi's MIT-licensed terminal Coding Agent at the
frozen commit recorded in the repository-level `THIRD_PARTY_NOTICES.md`.

No file in this package is currently copied or substantially derived from Pi.

## OpenAI Codex

The Permission Profile, approval, command-rule, model-escalation, and main-Timeline Tool-presentation behavior in this package was independently designed against the public OpenAI Codex checkout at commit `f93109615ff27ab58007601434b27c940d5500c7` (OpenAI Codex, Copyright 2025 OpenAI). It is a behavioral reimplementation rather than a mechanical Rust translation, and it does not link or require the local checkout at build or runtime.

The CLI runtime-activity shimmer is a behavioral reimplementation of Codex's public status shimmer at commit `8f4a2c99dd56e136894c2ef2221bd7f24f760dd7`. Coda retains its own TypeScript rendering, terminal palette, activity semantics, and reduced-motion policy.

OpenAI Codex is licensed under Apache License 2.0. The license and source attribution shipped by `@coda/sandbox` apply to the shared permission implementation; the studied public source is available at <https://github.com/openai/codex>.
