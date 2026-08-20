---
status: accepted
---

# Load Agent Plugins through existing capability seams

ADR-0063 supersedes this decision's exclusions of installation, enablement,
lifecycle management, and a Plugin capability source. The portable loader and
Skill/MCP seam ownership below remain accepted; the later Plugin source is
prompt-only guidance derived from the same coherent Plugin Inventory.

Coda implements the Agent Plugins 1.0.0 portable package contract in a private
leaf `@coda/plugins` package. It loads one caller-selected directory, validates
root `plugin.json`, discovers only fixed `skills/` and `mcp.json`, enforces the
filesystem-resolved Plugin root, delegates Agent Skill format loading to
`@coda/skills`, maps portable Server declarations to `@coda/mcp` transport
definitions, materializes stdio placeholders, and returns immutable Plugin
Snapshots with diagnostics. It does not own registries, installation, signing,
enablement, trust, client-extension namespaces, or a generic plugin lifecycle.

`@coda/coding-agent` owns the Workspace and user Plugin roots
(`<Workspace>/.agents/plugins/<name>` and `~/.agents/plugins/<name>`), Workspace
precedence, settings, trust, Plugin data placement, and presentation. A valid
package grants no execution authority: the Coding Agent maps validated Plugin
Skills onto the existing Skill Inventory seam and validated MCP entries onto
the existing MCP Server Definition seam, where their existing policy and trust
rules apply. Those two existing capability sources—and no Plugin capability
source—contribute to the Run Capability Lease.

This decision supersedes only ADR-0036's exact-root exclusion for Skills:
`<Plugin root>/skills/<name>/SKILL.md` is now an admitted Skill source only when
the enclosing Agent Plugin passed manifest and root-containment validation.
ADR-0036 otherwise remains accepted, including `@coda/skills` format ownership,
Coding Agent policy ownership, deterministic precedence, and exact-revision Run
activation; Coda still does not perform generic nested or foreign-client Skill
discovery.

ADR-0037 remains the protocol ownership decision: `@coda/mcp` owns connection,
transport, and lifecycle mechanics, while `@coda/plugins` only validates and
maps the portable declaration. Because Agent Plugins declarations select a
transport but do not declare an MCP wire-version policy, the Coding Agent maps
supported Plugin Servers to the MCP Host's automatic version negotiation.
Unsupported transports are skipped without
invalidating independent components, and legacy HTTP+SSE remains excluded.
ADR-0046 also remains unchanged: Agent Plugins are inputs to the existing Skill
and MCP sources, not a generic dependency-injection system or plugin container.

The executable dependency direction is therefore `plugins -> {skills, mcp}`
and `coding-agent -> plugins`; `runtime` cannot know `@coda/plugins`. Inside the
Coding Agent, only the application composition root imports the `plugins`
module, and that adapter may import host filesystem values; references to Skill
and MCP application vocabulary remain type-only. This keeps portable package
interpretation below product policy without moving application trust or Run
admission into the loader.
