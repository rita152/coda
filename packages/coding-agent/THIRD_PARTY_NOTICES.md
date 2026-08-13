# Third-party notices

`@coda/coding-agent` studies Pi's MIT-licensed terminal Coding Agent at the
frozen commit recorded in the repository-level `THIRD_PARTY_NOTICES.md`.

No file in this package is currently copied or substantially derived from Pi.

## OpenAI Codex

The CLI runtime-activity shimmer is a behavioral reimplementation of Codex's public status shimmer at commit `8f4a2c99dd56e136894c2ef2221bd7f24f760dd7`. Coda retains its own TypeScript rendering, terminal palette, activity semantics, and reduced-motion policy.

OpenAI Codex is licensed under Apache License 2.0; the studied public source is available at <https://github.com/openai/codex>.

## Native patch Tool design study

The native patch Tool in this package was independently implemented after an architectural and behavioral study of OpenAI Codex `902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe` (Apache-2.0), OpenCode `cc4b45612974f735ddec46009ede07729511fba4` (MIT), and Grok Build `e5fd4816d43260c15ba785f103990c1ed6cea230` / `SOURCE_REV=ea094a8c369475f97c85540d01730baec0dce5d6` (Apache-2.0). No upstream source was copied, mechanically translated, or linked. Coda owns the strict parser, exact-match semantics, mutation facts, and AtomicMutationWriter composition; only the public Codex-style marker vocabulary is intentionally interoperable.

The studied sources are available from <https://github.com/openai/codex>, <https://github.com/anomalyco/opencode>, and <https://github.com/xai-org/grok-build>.
