import { createHash } from "node:crypto";
import type { RunCapabilitySource } from "@coda/runtime";
import { acquireScopedProjectMcpRunExposure } from "../host/project-capability-acquisition.ts";
import type {
	AcquireProjectRunCapabilityBundle,
	ProjectRunCapabilityBundle,
} from "../runtime/project-capability-bundle.ts";
import type { CodingPlugin, CodingPluginsSnapshot } from "./types.ts";

const PLUGIN_GUIDANCE = [
	"### How to use plugins",
	"- Skill naming: If a plugin contributes skills, those skill entries are prefixed with `plugin_name:` in the Skills list.",
	"- MCP naming: Plugin-provided MCP tools keep standard MCP identifiers such as `mcp__server__tool`; use tool provenance to tell which plugin they come from.",
	"- Trigger rules: If the user explicitly names a plugin, prefer capabilities associated with that plugin for that turn.",
	"- Relationship to capabilities: Plugins are not invoked directly. Use their underlying skills, MCP tools, and app tools to help solve the task.",
	"- Relevance: Determine what a plugin can help with from explicit user mention or from the plugin-associated skills, MCP tools, and apps exposed elsewhere in this turn.",
	"- Missing/blocked: If the user requests a plugin that does not have relevant callable capabilities for the task, say so briefly and continue with the best fallback.",
] as const;

export interface CreatePluginsCapabilitySourceOptions {
	readonly acquireInventory?: (signal: AbortSignal) => CodingPluginsSnapshot | Promise<CodingPluginsSnapshot>;
	readonly acquireProjectBundle?: AcquireProjectRunCapabilityBundle;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function comparePlugins(left: CodingPlugin, right: CodingPlugin): number {
	return (
		compareText(left.snapshot.manifest.name, right.snapshot.manifest.name) ||
		compareText(left.snapshot.manifest.version ?? "", right.snapshot.manifest.version ?? "")
	);
}

function renderPluginGuidance(plugins: readonly CodingPlugin[]): string {
	if (plugins.length === 0) return "";
	return `<plugins_instructions>\n${[
		"## Plugins",
		"A plugin is a local bundle of skills, MCP servers, and apps.",
		...PLUGIN_GUIDANCE,
	].join("\n")}\n</plugins_instructions>`;
}

function capabilityContributingPlugins(
	inventory: CodingPluginsSnapshot,
	bundle: ProjectRunCapabilityBundle | undefined,
	exposedAgentPluginServerIds: readonly string[] = [],
): readonly CodingPlugin[] {
	if (!bundle) {
		return inventory.plugins.filter(
			(plugin) => plugin.snapshot.skills.candidates.length > 0 || plugin.snapshot.mcpServers.length > 0,
		);
	}
	const skillPluginNames = new Set(
		bundle.skills.resolved.flatMap(({ implicitInvocation, origin }) =>
			implicitInvocation && origin.kind === "plugin" && origin.pluginName ? [origin.pluginName] : [],
		),
	);
	const pluginServerIdsWithTools = new Set(exposedAgentPluginServerIds);
	const pluginIdsWithMcpTools = new Set(
		inventory.mcpSources.flatMap((source) =>
			source.servers.some(({ id }) => pluginServerIdsWithTools.has(id)) ? [source.plugin.installationId] : [],
		),
	);
	return inventory.plugins.filter(
		(plugin) =>
			skillPluginNames.has(plugin.snapshot.manifest.name) || pluginIdsWithMcpTools.has(plugin.installationId),
	);
}

function revisionFor(plugins: readonly CodingPlugin[]): string {
	const descriptors = plugins.map((plugin) => plugin.contentDigest);
	return createHash("sha256").update(descriptors.join("\n"), "utf8").digest("hex");
}

export function createPluginsCapabilitySource(options: CreatePluginsCapabilitySourceOptions): RunCapabilitySource {
	if (
		!options ||
		(typeof options.acquireInventory !== "function" && typeof options.acquireProjectBundle !== "function") ||
		(options.acquireInventory && options.acquireProjectBundle)
	) {
		throw new TypeError("Exactly one Plugin inventory or Project bundle acquisition source is required");
	}
	return Object.freeze({
		id: "plugins",
		acquire: async ({ signal, scope }: Parameters<RunCapabilitySource["acquire"]>[0]) => {
			signal.throwIfAborted();
			const scoped = options.acquireProjectBundle
				? await acquireScopedProjectMcpRunExposure(scope, options.acquireProjectBundle, signal)
				: undefined;
			const bundle = scoped?.bundle;
			const inventory = bundle ? bundle.plugins : await options.acquireInventory!(signal);
			signal.throwIfAborted();
			const plugins = Object.freeze([...inventory.plugins].sort(comparePlugins));
			const prompt = renderPluginGuidance(
				capabilityContributingPlugins(inventory, bundle, scoped?.exposure.agentPluginServerIds),
			);
			return Object.freeze({
				revision: bundle ? `${bundle.revision};plugins:${revisionFor(plugins)}` : revisionFor(plugins),
				tools: Object.freeze([]),
				promptFragments: Object.freeze(prompt ? [Object.freeze({ id: "plugins", text: prompt })] : []),
				dispose: () => undefined,
			});
		},
	});
}
