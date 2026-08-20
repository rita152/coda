import { createHash } from "node:crypto";
import { join } from "node:path";
import { AGENT_PLUGIN_SCHEMA, type LoadedPluginSnapshot } from "@coda/plugins";
import type { SkillId, SkillRevision, SkillsSnapshot } from "@coda/skills";
import { describe, expect, it } from "vitest";
import { createMcpCapabilitySource } from "../../src/mcp/run-capability.ts";
import { createPluginsCapabilitySource } from "../../src/plugins/run-capability.ts";
import type {
	CodingPlugin,
	CodingPluginMcpSource,
	CodingPluginOrigin,
	CodingPluginsSnapshot,
} from "../../src/plugins/types.ts";

interface PluginFixtureOptions {
	readonly root?: string;
	readonly slot?: string;
	readonly scope?: "workspace" | "user";
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly skills?: Readonly<Record<string, string>>;
	readonly mcpServers?: readonly string[];
	readonly mcpSha256?: string;
	readonly contentDigest?: string;
}

function pluginFixture(options: PluginFixtureOptions): CodingPlugin {
	const root = options.root ?? `/workspace/.agents/plugins/${options.slot ?? options.name}`;
	const slot = options.slot ?? options.name;
	const scope = options.scope ?? "workspace";
	const source = scope === "workspace" ? "workspace-local" : "user-local";
	const origin: CodingPluginOrigin = Object.freeze({
		scope,
		slot,
		pluginName: options.name,
		root,
		pluginRoot: root,
		priority: scope === "workspace" ? 1 : 3,
		sourceLabel: scope === "workspace" ? `./.agents/plugins/${slot}` : `~/.agents/plugins/${slot}`,
		kind: "plugin",
	});
	const candidates = Object.freeze(
		Object.entries(options.skills ?? {}).map(([name, revision]) =>
			Object.freeze({
				id: `${options.name}:${name}:id` as SkillId,
				revision: revision as SkillRevision,
				directory: join(root, "skills", name),
				skillFile: join(root, "skills", name, "SKILL.md"),
				metadata: Object.freeze({ name, description: `${name} workflow`, metadata: Object.freeze({}) }),
				conformant: true,
				provenance: Object.freeze([Object.freeze({ root: join(root, "skills"), origin, depth: 1 })]),
				diagnostics: Object.freeze([]),
			}),
		),
	);
	const skills: SkillsSnapshot<CodingPluginOrigin> = Object.freeze({
		candidates,
		diagnostics: Object.freeze([]),
		activate: async () => {
			throw new Error("Plugin guidance must not activate Skills");
		},
	});
	const mcpServers = Object.freeze(
		(options.mcpServers ?? []).map((name) =>
			Object.freeze({
				name,
				pluginName: options.name,
				pluginRoot: root,
				origin,
				configuration: Object.freeze({ type: "streamable-http" as const, url: "https://example.test/mcp" }),
			}),
		),
	);
	const snapshot: LoadedPluginSnapshot<CodingPluginOrigin> = Object.freeze({
		status: "loaded",
		requestedRoot: root,
		root,
		origin,
		manifest: Object.freeze({
			$schema: AGENT_PLUGIN_SCHEMA,
			name: options.name,
			...(options.version ? { version: options.version } : {}),
			...(options.description ? { description: options.description } : {}),
		}),
		skills,
		mcpServers,
		...(options.mcpSha256
			? { mcpConfiguration: Object.freeze({ path: join(root, "mcp.json"), sha256: options.mcpSha256 }) }
			: {}),
		diagnostics: Object.freeze([]),
		materializeMcp: async () => {
			throw new Error("Plugin Run guidance must not materialize MCP configuration");
		},
	});
	return Object.freeze({
		installationId: `${options.name}@${source}`,
		source,
		enabled: true,
		contentDigest:
			options.contentDigest ??
			createHash("sha256")
				.update(
					JSON.stringify({
						name: options.name,
						version: options.version ?? "",
						description: options.description?.replace(/\s+/gu, " ").trim() ?? "",
						skills: Object.entries(options.skills ?? {}).sort(([left], [right]) => left.localeCompare(right)),
						mcpServers: [...(options.mcpServers ?? [])].sort(),
						mcpSha256: options.mcpSha256 ?? "",
					}),
				)
				.digest("hex"),
		slot,
		origin,
		dataDirectory: `/cache/${slot}`,
		snapshot,
	});
}

function inventoryFixture(plugins: readonly CodingPlugin[]): CodingPluginsSnapshot {
	const mcpSources: CodingPluginMcpSource[] = plugins.flatMap((plugin) => {
		const configuration = plugin.snapshot.mcpConfiguration;
		if (!configuration) return [];
		return [
			Object.freeze({
				plugin,
				path: configuration.path,
				sha256: configuration.sha256,
				requiresWorkspaceTrust: plugin.origin.scope === "workspace",
				servers: Object.freeze(
					plugin.snapshot.mcpServers.map(({ name, configuration: server }) =>
						Object.freeze({
							id: `plugin_${plugin.snapshot.manifest.name}_${name}`,
							name,
							type: server.type,
						}),
					),
				),
			}),
		];
	});
	return Object.freeze({
		installations: Object.freeze([...plugins]),
		plugins: Object.freeze([...plugins]),
		snapshots: Object.freeze(plugins.map(({ snapshot }) => snapshot)),
		skills: Object.freeze(plugins.map(({ snapshot }) => snapshot.skills)),
		mcpSources: Object.freeze(mcpSources),
		diagnostics: Object.freeze([]),
	});
}

describe("Plugin Run capability source", () => {
	it("renders the exact generic Codex Plugin instructions without inventory details", async () => {
		const inventory = inventoryFixture([
			pluginFixture({
				name: "review-tools",
				version: "1.2.3",
				description: "Review changes safely",
				skills: { test: "skill-test-r1", review: "skill-review-r1" },
				mcpServers: ["search", "docs"],
				mcpSha256: "a".repeat(64),
			}),
		]);
		let acquisitions = 0;
		const source = createPluginsCapabilitySource({
			acquireInventory: () => {
				acquisitions++;
				return inventory;
			},
		});
		const lease = await source.acquire({ model: undefined as never, signal: new AbortController().signal });

		expect(source.id).toBe("plugins");
		expect(acquisitions).toBe(1);
		expect(lease.tools).toEqual([]);
		expect(lease.revision).toMatch(/^[a-f0-9]{64}$/u);
		expect(lease.promptFragments).toEqual([
			{
				id: "plugins",
				text: `<plugins_instructions>
## Plugins
A plugin is a local bundle of skills, MCP servers, and apps.
### How to use plugins
- Skill naming: If a plugin contributes skills, those skill entries are prefixed with \`plugin_name:\` in the Skills list.
- MCP naming: Plugin-provided MCP tools keep standard MCP identifiers such as \`mcp__server__tool\`; use tool provenance to tell which plugin they come from.
- Trigger rules: If the user explicitly names a plugin, prefer capabilities associated with that plugin for that turn.
- Relationship to capabilities: Plugins are not invoked directly. Use their underlying skills, MCP tools, and app tools to help solve the task.
- Relevance: Determine what a plugin can help with from explicit user mention or from the plugin-associated skills, MCP tools, and apps exposed elsewhere in this turn.
- Missing/blocked: If the user requests a plugin that does not have relevant callable capabilities for the task, say so briefly and continue with the best fallback.
</plugins_instructions>`,
			},
		]);
		await lease.dispose();
	});

	it("contributes no fragment or Tool when no Plugins are enabled", async () => {
		const inventory = inventoryFixture([]);
		const source = createPluginsCapabilitySource({ acquireInventory: async () => inventory });
		const lease = await source.acquire({ model: undefined as never, signal: new AbortController().signal });

		expect(lease.tools).toEqual([]);
		expect(lease.promptFragments).toEqual([]);
		expect(lease.revision).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("contributes no fragment for an enabled manifest that has no effective Skill or MCP capability", async () => {
		const inventory = inventoryFixture([pluginFixture({ name: "metadata-only" })]);
		const source = createPluginsCapabilitySource({ acquireInventory: async () => inventory });
		const lease = await source.acquire({ model: undefined as never, signal: new AbortController().signal });

		expect(lease.promptFragments).toEqual([]);
	});

	it("uses final product-gated Skill and ready MCP projections when deciding whether Plugin guidance exists", async () => {
		const plugin = pluginFixture({ name: "foreign-only", skills: { foreign: "foreign-r1" } });
		const inventory = inventoryFixture([plugin]);
		const bundle = Object.freeze({
			revision: "project:1",
			plugins: inventory,
			skills: Object.freeze({ resolved: Object.freeze([]) }),
			mcp: Object.freeze({
				revision: 1,
				servers: Object.freeze([]),
				tools: Object.freeze([]),
				agentPluginServerIds: Object.freeze([]),
				callTool: async () => {
					throw new Error("No MCP Tool is available");
				},
				dispose: async () => undefined,
			}),
			dispose: async () => undefined,
		}) as never;
		const source = createPluginsCapabilitySource({ acquireProjectBundle: async () => bundle });
		const scopeValues = new Map<unknown, unknown>();
		const lease = await source.acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			scope: {
				getOrCreate: async <T>(key: unknown, create: () => T | PromiseLike<T>) => {
					if (!scopeValues.has(key)) scopeValues.set(key, await create());
					return scopeValues.get(key) as T;
				},
			},
		});

		expect(lease.promptFragments).toEqual([]);
	});

	it("contributes no guidance for a Plugin whose only final Skill is slash-only", async () => {
		const plugin = pluginFixture({ name: "slash-only", skills: { review: "review-r1" } });
		const inventory = inventoryFixture([plugin]);
		const bundle = Object.freeze({
			revision: "project:slash-only",
			plugins: inventory,
			skills: Object.freeze({
				resolved: Object.freeze([Object.freeze({ origin: plugin.origin, implicitInvocation: false })]),
			}),
			mcp: Object.freeze({
				revision: 1,
				servers: Object.freeze([]),
				tools: Object.freeze([]),
				agentPluginServerIds: Object.freeze([]),
				callTool: async () => {
					throw new Error("No MCP Tool is available");
				},
				dispose: async () => undefined,
			}),
			dispose: async () => undefined,
		}) as never;
		const source = createPluginsCapabilitySource({ acquireProjectBundle: async () => bundle });
		const scopeValues = new Map<unknown, unknown>();
		const lease = await source.acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			scope: {
				getOrCreate: async <T>(key: unknown, create: () => T | PromiseLike<T>) => {
					if (!scopeValues.has(key)) scopeValues.set(key, await create());
					return scopeValues.get(key) as T;
				},
			},
		});

		expect(lease.promptFragments).toEqual([]);
	});

	it("shares one final model-visible MCP exposure for Tool admission and Plugin guidance", async () => {
		const plugin = pluginFixture({
			name: "mcp-only",
			mcpServers: ["docs"],
			mcpSha256: "a".repeat(64),
		});
		const inventory = inventoryFixture([plugin]);
		const serverId = inventory.mcpSources[0]!.servers[0]!.id;
		const oversizedToolId = `mcp:${serverId}:oversized`;
		let descriptionReads = 0;
		const oversized = Object.freeze({
			id: oversizedToolId,
			serverId,
			serverSemanticName: "mcp-only:docs",
			remoteName: "oversized",
			name: `mcp__${serverId}__oversized`,
			get description() {
				descriptionReads++;
				return "x".repeat(8_100);
			},
			inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}) }),
		});
		const appOnly = Object.freeze({
			id: `mcp:${serverId}:app-only`,
			serverId,
			serverSemanticName: "mcp-only:docs",
			remoteName: "app-only",
			name: `mcp__${serverId}__app-only`,
			description: "app-only",
			inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}) }),
			meta: Object.freeze({ ui: Object.freeze({ visibility: Object.freeze(["app"]) }) }),
		});
		const mcp = Object.freeze({
			revision: 7,
			servers: Object.freeze([
				Object.freeze({ id: serverId, semanticName: "mcp-only:docs", status: "ready", toolCount: 2 }),
			]),
			tools: Object.freeze([appOnly, oversized]),
			agentPluginServerIds: Object.freeze([serverId]),
			callTool: async () => ({ isError: false, content: Object.freeze([]) }),
			dispose: async () => undefined,
		});
		let bundleAcquisitions = 0;
		const bundle = Object.freeze({
			revision: "project:shared-exposure",
			plugins: inventory,
			skills: Object.freeze({ resolved: Object.freeze([]) }),
			mcp,
			dispose: async () => undefined,
		}) as never;
		const acquireProjectBundle = async () => {
			bundleAcquisitions++;
			return bundle;
		};
		const diagnostics: string[] = [];
		const mcpSource = createMcpCapabilitySource({
			acquireProjectBundle,
			diagnostic: ({ code }) => {
				diagnostics.push(code);
			},
		});
		const pluginSource = createPluginsCapabilitySource({ acquireProjectBundle });
		const values = new Map<unknown, unknown>();
		const scope = {
			getOrCreate: async <T>(key: unknown, create: () => T | PromiseLike<T>) => {
				if (!values.has(key)) values.set(key, await create());
				return values.get(key) as T;
			},
		};

		const mcpLease = await mcpSource.acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			selection: { toolIds: [oversizedToolId] },
			scope,
		});
		const pluginLease = await pluginSource.acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			scope,
		});

		expect(mcpLease.tools).toEqual([]);
		expect(pluginLease.promptFragments).toEqual([]);
		expect(diagnostics).toEqual(["mcp.agent-plugin-tool-budget-exceeded"]);
		expect(descriptionReads).toBe(1);
		expect(bundleAcquisitions).toBe(1);
	});

	it("does not let an aggregate-hidden Plugin server trigger guidance", async () => {
		const plugin = pluginFixture({
			name: "zeta-tools",
			mcpServers: ["docs"],
			mcpSha256: "b".repeat(64),
		});
		const inventory = inventoryFixture([plugin]);
		const targetServerId = inventory.mcpSources[0]!.servers[0]!.id;
		const targetToolId = `mcp:${targetServerId}:overflow`;
		const descriptor = (serverId: string, remoteName: string, description: string) =>
			Object.freeze({
				id: `mcp:${serverId}:${remoteName}`,
				serverId,
				serverSemanticName: serverId,
				remoteName,
				name: `mcp__${serverId}__${remoteName}`,
				description,
				inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}) }),
			});
		const fillerServerId = "aaa-budget-filler";
		const fillerTools = Array.from({ length: 8 }, (_, index) =>
			descriptor(fillerServerId, `filler-${index}`, "f".repeat(7_600)),
		);
		const target = descriptor(targetServerId, "overflow", "t".repeat(3_000));
		const mcp = Object.freeze({
			revision: 8,
			servers: Object.freeze([
				Object.freeze({ id: fillerServerId, semanticName: fillerServerId, status: "ready", toolCount: 8 }),
				Object.freeze({ id: targetServerId, semanticName: "zeta-tools:docs", status: "ready", toolCount: 1 }),
			]),
			tools: Object.freeze([...fillerTools, target]),
			agentPluginServerIds: Object.freeze([fillerServerId, targetServerId].sort()),
			callTool: async () => ({ isError: false, content: Object.freeze([]) }),
			dispose: async () => undefined,
		});
		const bundle = Object.freeze({
			revision: "project:aggregate-exposure",
			plugins: inventory,
			skills: Object.freeze({ resolved: Object.freeze([]) }),
			mcp,
			dispose: async () => undefined,
		}) as never;
		const acquireProjectBundle = async () => bundle;
		const values = new Map<unknown, unknown>();
		const scope = {
			getOrCreate: async <T>(key: unknown, create: () => T | PromiseLike<T>) => {
				if (!values.has(key)) values.set(key, await create());
				return values.get(key) as T;
			},
		};
		const diagnostics: string[] = [];
		const mcpLease = await createMcpCapabilitySource({
			acquireProjectBundle,
			diagnostic: ({ code }) => {
				diagnostics.push(code);
			},
		}).acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			selection: { toolIds: [targetToolId] },
			scope,
		});
		const pluginLease = await createPluginsCapabilitySource({ acquireProjectBundle }).acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			scope,
		});

		expect(mcpLease.tools).toHaveLength(8);
		expect(mcpLease.tools.map(({ tool }) => tool.name)).not.toContain(target.name);
		expect(mcpLease.revision).toContain(`agentPlugins:[${JSON.stringify(fillerServerId)}]`);
		expect(pluginLease.promptFragments).toEqual([]);
		expect(diagnostics).toEqual(["mcp.agent-plugin-total-budget-exceeded"]);
	});

	it("keeps Plugin guidance when a final Skill contributes even if every Plugin MCP Tool is hidden", async () => {
		const plugin = pluginFixture({
			name: "skill-backed",
			skills: { review: "review-r1" },
			mcpServers: ["docs"],
			mcpSha256: "c".repeat(64),
		});
		const inventory = inventoryFixture([plugin]);
		const bundle = Object.freeze({
			revision: "project:skill-backed",
			plugins: inventory,
			skills: Object.freeze({
				resolved: Object.freeze([Object.freeze({ origin: plugin.origin, implicitInvocation: true })]),
			}),
			mcp: Object.freeze({
				revision: 9,
				servers: Object.freeze([]),
				tools: Object.freeze([]),
				agentPluginServerIds: Object.freeze([]),
				callTool: async () => ({ isError: false, content: Object.freeze([]) }),
				dispose: async () => undefined,
			}),
			dispose: async () => undefined,
		}) as never;
		const source = createPluginsCapabilitySource({ acquireProjectBundle: async () => bundle });
		const values = new Map<unknown, unknown>();
		const lease = await source.acquire({
			model: undefined as never,
			signal: new AbortController().signal,
			scope: {
				getOrCreate: async <T>(key: unknown, create: () => T | PromiseLike<T>) => {
					if (!values.has(key)) values.set(key, await create());
					return values.get(key) as T;
				},
			},
		});

		expect(lease.promptFragments).toHaveLength(1);
		expect(lease.promptFragments[0]!.text).toContain("<plugins_instructions>");
	});

	it("keeps revision path-independent while tracking effective availability and inventory changes", async () => {
		const mcpSha256 = "b".repeat(64);
		const original = pluginFixture({
			root: "/first/workspace/.agents/plugins/private-slot",
			slot: "private-slot",
			scope: "workspace",
			name: "review-tools",
			version: "2.0.0",
			description: "Review\nchanges",
			skills: { test: "test-r1", review: "review-r1" },
			mcpServers: ["search", "docs"],
			mcpSha256,
		});
		const moved = pluginFixture({
			root: "/second/home/.agents/plugins/moved-cache-slot",
			slot: "moved-cache-slot",
			scope: "user",
			name: "review-tools",
			version: "2.0.0",
			description: "Review changes",
			skills: { review: "review-r1", test: "test-r1" },
			mcpServers: ["docs", "search"],
			mcpSha256,
		});
		const acquire = async (plugin: CodingPlugin) => {
			const source = createPluginsCapabilitySource({ acquireInventory: () => inventoryFixture([plugin]) });
			return source.acquire({ model: undefined as never, signal: new AbortController().signal });
		};
		const originalLease = await acquire(original);
		const movedLease = await acquire(moved);
		const emptyLease = await createPluginsCapabilitySource({ acquireInventory: () => inventoryFixture([]) }).acquire({
			model: undefined as never,
			signal: new AbortController().signal,
		});

		expect(movedLease.revision).toBe(originalLease.revision);
		expect(emptyLease.revision).not.toBe(originalLease.revision);
		expect(movedLease.promptFragments).toEqual(originalLease.promptFragments);
		const prompt = originalLease.promptFragments[0]?.text ?? "";
		expect(prompt).not.toContain("/first/workspace");
		expect(prompt).not.toContain("private-slot");
		expect(prompt).not.toContain("/cache/");
		expect(prompt).not.toContain(mcpSha256);

		const changedManifest = await acquire(
			pluginFixture({
				name: "review-tools",
				version: "2.1.0",
				description: "Review changes",
				skills: { review: "review-r1", test: "test-r1" },
				mcpServers: ["docs", "search"],
				mcpSha256,
			}),
		);
		const changedSkill = await acquire(
			pluginFixture({
				name: "review-tools",
				version: "2.0.0",
				description: "Review changes",
				skills: { review: "review-r2", test: "test-r1" },
				mcpServers: ["docs", "search"],
				mcpSha256,
			}),
		);
		const changedMcp = await acquire(
			pluginFixture({
				name: "review-tools",
				version: "2.0.0",
				description: "Review changes",
				skills: { review: "review-r1", test: "test-r1" },
				mcpServers: ["docs", "search"],
				mcpSha256: "c".repeat(64),
			}),
		);
		const changedResource = await acquire(
			pluginFixture({
				name: "review-tools",
				version: "2.0.0",
				description: "Review changes",
				skills: { review: "review-r1", test: "test-r1" },
				mcpServers: ["docs", "search"],
				mcpSha256,
				contentDigest: "d".repeat(64),
			}),
		);

		expect(changedManifest.revision).not.toBe(originalLease.revision);
		expect(changedSkill.revision).not.toBe(originalLease.revision);
		expect(changedMcp.revision).not.toBe(originalLease.revision);
		expect(changedResource.revision).not.toBe(originalLease.revision);
		expect(changedManifest.promptFragments).toEqual(originalLease.promptFragments);
		expect(changedSkill.promptFragments).toEqual(originalLease.promptFragments);
		expect(changedMcp.promptFragments).toEqual(originalLease.promptFragments);
	});
});
