# `@coda/plugins`

Agent Plugins 1.0.0-compatible package loading, fixed-location component discovery, filesystem containment, and
immutable portable snapshots for Coda.

This private package owns only the neutral [Agent Plugins specification](https://agent-plugins.org/specification)
contract. It loads an absolute Plugin root from `plugin.json`, discovers immediate Agent Skills below `skills/` and
MCP Servers from root `mcp.json`, and applies the specification's narrow component and entry failure boundaries. It
delegates Skill parsing, validation, snapshots, and activation to `@coda/skills`, and emits `@coda/mcp` transport
definitions instead of implementing either standard again.

## API

The caller supplies the filesystem, an absolute root, opaque provenance, and optional cancellation and byte limits:

```ts
const plugins = createPlugins({ fileSystem });
const snapshot = await plugins.load({ root, origin, signal });

if (snapshot.status === "loaded") {
	console.log(snapshot.manifest.$schema, snapshot.skills.candidates, snapshot.mcpServers);
}
```

A loaded snapshot retains the validated portable manifest, the immutable strict `@coda/skills` snapshot, validated
MCP entries, source configuration identity, and diagnostics. Invalid `plugin.json` rejects the Plugin. A missing
component location is normal; a present invalid component disables only that component; an invalid MCP Server or
Skill is skipped without suppressing valid siblings.

Before launching stdio MCP Servers, the caller provides a canonicalizable, client-managed data directory, selected
base environment, and platform semantics:

```ts
const materialized = await snapshot.materializeMcp({
	dataRoot,
	dataDirectory,
	baseEnvironment,
	platform: process.platform,
	signal,
});
```

Materialization expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `args`, `env` values, and `cwd`, overlays and
forces the reserved environment entries, and records filesystem identity leases for the Plugin root, client data
directories, Plugin-relative executable, and configured working directory. It rechecks those leases before exposing
each stdio definition. The stdio definition also carries a non-enumerable, runtime-only `beforeLaunch(signal?)`
closure so `@coda/mcp` can recheck the same leases immediately before transport construction. The closure is not
portable configuration and must not enter persistence, revision/hash input, or machine-readable output.

Materialization never launches a process or opens a network connection. A launch-guard failure degrades only that
stdio Server; HTTP and other valid siblings remain available. The guard closes deterministic application-level
replacement windows but cannot eliminate the small guard-to-spawn window without an OS descriptor/`openat`-based
launch primitive. Legacy HTTP+SSE entries are reported and skipped; stdio and Streamable HTTP entries are represented
through the existing `@coda/mcp` transport definition seam.

## Bounds and authority

Manifest and MCP configuration reads have conservative byte limits. Package-wide immediate Skill scan and component
budgets are applied before each accepted Skill child is loaded through an independent bounded `@coda/skills`
snapshot, so per-root budget resets cannot bypass the package cap and exhausting one valid Skill subtree cannot
suppress a sibling. Package paths are accepted only when their filesystem-resolved targets remain inside the
canonical Plugin root, with the separately supplied Plugin data directory serving as the only additional `cwd`
containment root.

The package does not discover installation roots, choose workspace or user precedence, trust Plugin content, manage
settings or persistent data, map capabilities into a Run lease, launch MCP transports, watch files, install from a
registry, verify signatures, or interpret client extension namespaces. Those are product and lifecycle concerns of
`@coda/coding-agent` or other owning modules.
