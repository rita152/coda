---
status: accepted
---

# Hide slash-only Skills from the model catalog

Coda keeps exact-revision Skill activation on the `skill` Tool, and matches Codex's model-visible catalog so auto-load and `$` injection feel the same. Skills with `disable-model-invocation: true` or `agents/openai.yaml` `policy.allow_implicit_invocation: false` stay in the Composer `$` palette and can still be `$`-injected, but they are omitted from the per-Run catalog and the `skill` Tool list. The catalog uses Codex's `<skills_instructions>` wrapper, name / description / `file:` locator shape, and trigger copy, including skip-accountability. The `skill` Tool remains the preferred exact-revision activation; opening the listed `SKILL.md` path is the Codex-compatible fallback.

This supersedes ADR-0036's claim that companion vendor manifests have no product semantics: `@coda/skills` still treats those fields as non-standard (`unknown-field`), while `@coda/coding-agent` reads them for catalog visibility only. Skill text remains contextual guidance and cannot grant Tool, filesystem, process, or network authority.
