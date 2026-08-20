# Add stable Plugin namespaces and deterministic model guidance

Type: task
Status: resolved
Priority: P0

Replace slot-, scope-, cache-, and hash-derived Plugin component identity with
one manifest-derived Plugin Namespace, and present enabled Plugin capabilities
to the user and model with the same names.

## Dependencies

- Issues 01 and 02 supply resolved, enabled Plugin Installations.

## Acceptance

- The validated manifest name is the Plugin Namespace and is unchanged by
  installation path, cache path, scope, source, or version updates.
- Plugin Skills have canonical names `<plugin-name>:<skill-name>` and Plugin MCP
  Servers have semantic names `<plugin-name>:<server-name>`. Any host-safe Tool
  encoding is deterministic and preserves that semantic identity.
- Two Plugins contributing a same-named Skill or Server remain unambiguous
  without opaque hashes. Duplicate Plugin Namespace conflicts are diagnosed at
  installation selection rather than leaked into component names.
- The Prompt Builder emits Codex 0.148's byte-stable generic Plugin guidance
  when at least one enabled, valid Plugin is available, and emits no Plugin
  fragment otherwise. The generic fragment does not list Plugin inventory;
  stable Plugin Skill names remain in the Skills catalog and MCP Tool
  provenance remains at the MCP seam. It does not auto-load Skill bodies or
  bypass MCP trust, visibility, or per-Run budget rules.
- Composer references, Skill catalogs, MCP views, Tool descriptors, diagnostics,
  and machine output use the same canonical names.
- Snapshot tests prove names and prompt content remain byte-stable when an
  installation moves, upgrades, or changes scope, and that the generic guidance
  appears or disappears with effective Plugin availability.
- The live HTTPS fixture is invoked by its stable Skill and MCP names before and
  after an upgrade; prompt excerpts and observed Tool descriptors are appended
  under `## Comments` before resolution.

## Ownership

Put namespace and presentation policy in the Coding Agent adapter and Prompt
Builder. Do not add client namespaces to the portable Plugin Snapshot or expose
installation paths through the Run contract.

## Comments

- 2026-08-19 offline evidence: `inventory.test.ts` derives Plugin data,
  component identity, and collision selection from validated manifest identity
  rather than slot or path. `skills/inventory.test.ts` uses
  `<plugin-name>:<skill-name>` for catalog and activation. Plugin and MCP Run
  capability tests preserve deterministic host-safe Tool identity, direct ready
  Tool exposure, byte budgets, and the exact generic
  `<plugins_instructions>` fragment only when an effective capability exists.
  Moving an installation, changing scope, or upgrading does not introduce a
  path/hash namespace.
- 2026-08-19 observed network evidence: managed package discovery retained
  `agent-plugins-example@official-example`, projected Plugin Skill provenance
  from namespace `agent-plugins-example`, and produced the path-independent MCP
  Server identity `plugin_agent-plugins-example_openai-docs`. The real HTTPS MCP
  call passed after content-addressed installation.
- 2026-08-19 current live-harness evidence encodes the same canonical Skill and
  MCP identities before/after upgrade, matching machine-readable and
  interactive detail, and old/new Skill body evidence across an active Run.
  The sealing rerun and the AIUP `aiup-core` six-Skill/Context7 name list remain
  TODO; Status is intentionally unchanged.
- 2026-08-20 final evidence: all seven live scenarios passed. The AIUP fixture
  exposed its six `aiup-core:*` Skill names and semantic Server
  `aiup-core:context7`; the model-visible Tool description carried that exact
  provenance. Slash-only Skills and unavailable/over-budget MCP components did
  not trigger Plugin guidance, while effective model-visible capabilities did.
  Composer, Skill/MCP views, Tool details, diagnostics, JSON, and TUI share the
  stable namespaces verified by the complete offline suite.
