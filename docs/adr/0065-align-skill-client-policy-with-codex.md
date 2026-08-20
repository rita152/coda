---
status: accepted
---

# Align Skill client policy with Codex

Coda keeps Agent Skills as the portable Skill format while matching desktop
Codex's client behavior for discovery, presentation, explicit selection, and
OpenAI sidecar metadata. `@coda/skills` remains a product-neutral, bounded
loader. `@coda/coding-agent` owns every client-specific root, precedence rule,
sidecar interpretation, namespace, prompt fragment, and installation decision.

For a Workspace inside a repository, Coda discovers `.agents/skills` at each
directory from the nearest repository root through the active Workspace, with
the nearest directory winning. It then considers Agent Plugin Skills, the
standard user root `~/.agents/skills`, and the deprecated user root
`~/.codex/skills`. Missing roots remain watched so their first creation becomes
visible without restarting. Coda does not scan Codex Plugin caches or infer a
Plugin package from `.codex-plugin/plugin.json`; Agent Plugin Skills enter only
through a validated Agent Plugins 1.0.0 package under ADR-0063.

The Coding Agent parses `agents/openai.yaml` as structured YAML through a
64-KiB pre-stat and post-read limit with at most sixteen concurrent sidecar
reads. A YAML or recognized-field type error ignores the whole optional
sidecar and emits a bounded diagnostic; unknown fields remain forward
compatible. Display name, short description, and default prompt are normalized
to one line before their character limits are enforced. The `interface`
projection supplies those values plus optional visual metadata.
`policy.allow_implicit_invocation` controls model-catalog visibility, while
`policy.products` gates the Skill for this product before name collisions are
resolved. `dependencies.tools` describes client-owned external Tool
requirements; it never grants execution authority or silently overwrites an
existing MCP Server configuration.

Direct and Agent Plugin Skills use the same product semantics. Plugin Skills
receive the stable `plugin-name:skill-name` client namespace. Catalog entries
use the Skill frontmatter description, while
`interface.short_description` remains presentation metadata for Composer and
management views. The model catalog uses Codex's bounded
`<skills_instructions>` protocol with metadata plus a `SKILL.md` locator rather
than Skill bodies. For a known Model context window, metadata receives two
percent of that window using the same four-UTF-8-bytes-per-token approximation
and round-robin description allocation as the recorded Codex client; there is
no unrelated 8-KiB cap on the complete catalog fragment. A row that cannot fit
does not starve later rows, and no fragment is emitted when even the omission
marker exceeds the budget. Explicit activation injects the exact selected raw
`SKILL.md` through the Codex `<skill>` fragment, bounded to 8,000 UTF-8 bytes.
Referenced scripts, assets, and other files are read on demand through ordinary
Tools rather than being enumerated into the prompt.

Only an explicitly selected Skill may propose missing MCP dependencies. The
Coding Agent canonicalizes those declarations, reports malformed or
conflicting requirements, and shows the canonical command or URL together with
Agent Plugin provenance during consent. A Plugin-relative stdio command must
remain contained by its canonical Plugin root; an escape is diagnosed and can
never be persisted or auto-approved. Workspace Plugin executables require
explicit consent even under the otherwise headless auto-install policy.
Interactive consent is rendered inside the active chat TUI; its standalone
terminal fallback may run only when no full-screen output lease is active.
Accepted settings use the Settings Store's transactional update interface so a
concurrent unrelated edit cannot be overwritten, and rollback removes only the
exact configuration this transition added. Typed
`dependencies.tools.oauth.callbackPort`/`callback_port` metadata is preserved
as `callbackPort`; because Coda does not execute Skill-dependency OAuth, it
reports authentication as client-managed rather than implying that login
succeeded. A declined dependency does not block explicit Skill use; the Run
continues without that capability and the limitation is visible.

One Prepared Run binds explicit Skill content, the resolved Skill revision, and
its Plugin/MCP projections to one Project capability revision. Refresh,
upgrade, disablement, or removal affects a later Run only. A package revision
retained by an active Run cannot be physically retired until that lease is
released.

This decision supersedes ADR-0036's fixed-root, no-ancestor, and
frontmatter-only client policy, and refines ADR-0058's sidecar and activation
presentation policy. It does not make Codex's Plugin manifest a supported
format and does not move client behavior into the portable loaders.
