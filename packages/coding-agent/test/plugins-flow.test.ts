import { describe, expect, it, vi } from "vitest";
import {
	createPluginsCommandFlow,
	type PluginsCommandFlowOperations,
	type PluginsCommandFlowSnapshot,
} from "../src/commands/plugins-flow.ts";
import { CodingPluginChangeNotificationError } from "../src/plugins/management.ts";

describe("Plugins command flow", () => {
	it("browses stable PluginIds and opens a diagnostic-bearing detail menu", () => {
		const snapshot = pluginSnapshot();
		const flow = createPluginsCommandFlow({ snapshot, operations: operations(snapshot) });

		expect(flow.id).toBe("plugins");
		expect(flow.items.map(({ id }) => id)).toEqual(["diagnostics", "refresh", "alpha@team", "zeta@team"]);
		expect(flow.items[2]).toMatchObject({ label: "Alpha", status: "available" });
		expect(flow.items[3]).toMatchObject({ label: "Zeta", status: "update-available" });
		const diagnosticPush = vi.fn();
		flow.items[0]!.onSelect!({ push: diagnosticPush, back: vi.fn(), close: vi.fn() });
		expect(diagnosticPush).toHaveBeenCalledWith(
			expect.objectContaining({
				items: expect.arrayContaining([
					expect.objectContaining({ description: "alpha:review: Alpha needs attention" }),
					expect.objectContaining({ description: "zeta:docs: Needs attention" }),
				]),
			}),
		);

		const push = vi.fn();
		flow.items[3]!.onSelect!({ push, back: vi.fn(), close: vi.fn() });
		const detail = push.mock.calls[0]![0];
		expect(detail).toEqual(
			expect.objectContaining({
				id: "plugins:detail:zeta@team",
				title: "Zeta",
				items: expect.arrayContaining([
					expect.objectContaining({ id: "plugin-id", description: "zeta@team" }),
					expect.objectContaining({ id: "namespace", description: "zeta" }),
					expect.objectContaining({ id: "marketplace", description: "team" }),
					expect.objectContaining({ id: "diagnostics", description: "1 total" }),
				]),
			}),
		);
		const diagnosticDetailPush = vi.fn();
		detail.items.find(({ id }: { readonly id: string }) => id === "diagnostics")!.onSelect!({
			push: diagnosticDetailPush,
			back: vi.fn(),
			close: vi.fn(),
		});
		expect(diagnosticDetailPush).toHaveBeenCalledWith(
			expect.objectContaining({
				items: [expect.objectContaining({ description: "zeta:docs: Needs attention" })],
			}),
		);
	});

	it("installs an available Plugin and replaces the flow with the returned latest snapshot", async () => {
		const before = pluginSnapshot();
		const after = withState(before, "alpha@team", "enabled", "2.0.0");
		const actions = operations(before);
		vi.mocked(actions.install).mockResolvedValue(after);
		const detail = createPluginsCommandFlow({
			snapshot: before,
			operations: actions,
			selector: "alpha@team",
		});
		expect(detail.items.map(({ id }) => id)).toContain("install");

		const replace = vi.fn();
		await detail.items.find(({ id }) => id === "install")!.onSelect!({
			push: vi.fn(),
			replace,
			back: vi.fn(),
			close: vi.fn(),
		});

		expect(actions.install).toHaveBeenCalledWith("alpha@team", expect.any(Function));
		expect(replace).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "plugins",
				items: expect.arrayContaining([expect.objectContaining({ id: "alpha@team", status: "enabled" })]),
			}),
		);
	});

	it("reviews exact Workspace Plugin MCP identity inside the existing command flow", async () => {
		const before = withState(pluginSnapshot(), "zeta@team", "disabled", "1.0.0");
		const after = withState(before, "zeta@team", "enabled", "1.0.0");
		const actions = operations(before);
		vi.mocked(actions.enable).mockImplementation(async (_pluginId, review) => {
			expect(
				await review!({
					workspace: "/workspace",
					pluginId: "zeta@team",
					path: "/workspace/.agents/plugins/zeta/mcp.json",
					sha256: "a".repeat(64),
				}),
			).toBe(true);
			return after;
		});
		const detail = createPluginsCommandFlow({ snapshot: before, operations: actions, selector: "zeta@team" });
		let confirmation: ReturnType<typeof createPluginsCommandFlow> | undefined;
		const replace = vi.fn();
		const back = vi.fn();
		const navigation = {
			push: (screen: ReturnType<typeof createPluginsCommandFlow>) => {
				confirmation = screen;
			},
			replace,
			back,
			close: vi.fn(),
		};

		const pending = detail.items.find(({ id }) => id === "enable")!.onSelect!(navigation);
		await vi.waitFor(() => expect(confirmation?.id).toBe("plugins:workspace-mcp-trust"));
		expect(confirmation?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "workspace", description: "/workspace" }),
				expect.objectContaining({ id: "plugin-id", description: "zeta@team" }),
				expect.objectContaining({ id: "path", description: "/workspace/.agents/plugins/zeta/mcp.json" }),
				expect.objectContaining({ id: "sha256", description: "a".repeat(64) }),
			]),
		);
		await confirmation!.items.find(({ id }) => id === "trust")!.onSelect!(navigation);
		await pending;

		expect(actions.enable).toHaveBeenCalledWith("zeta@team", expect.any(Function));
		expect(back).toHaveBeenCalledOnce();
		expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: "plugins" }));
	});

	it("rebuilds from a committed lifecycle snapshot before showing its notification warning", async () => {
		const before = pluginSnapshot();
		const committed = withState(before, "alpha@team", "enabled", "2.0.0");
		const actions = operations(before);
		vi.mocked(actions.install).mockRejectedValue(
			new CodingPluginChangeNotificationError(
				committed as unknown as ConstructorParameters<typeof CodingPluginChangeNotificationError>[0],
				new Error("refresh unavailable"),
			),
		);
		const detail = createPluginsCommandFlow({ snapshot: before, operations: actions, selector: "alpha@team" });
		const replace = vi.fn();

		await detail.items.find(({ id }) => id === "install")!.onSelect!({
			push: vi.fn(),
			replace,
			back: vi.fn(),
			close: vi.fn(),
		});

		expect(replace).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "plugins",
				items: expect.arrayContaining([
					expect.objectContaining({
						id: "committed-warning",
						label: "Change committed with warning",
					}),
					expect.objectContaining({ id: "alpha@team", status: "enabled" }),
				]),
			}),
		);
	});

	it("offers only state-valid enable, disable, upgrade, and remove actions", async () => {
		const snapshot = pluginSnapshot();
		const actions = operations(snapshot);
		const enabled = createPluginsCommandFlow({ snapshot, operations: actions, selector: "zeta@team" });
		expect(enabled.items.map(({ id }) => id)).toEqual([
			"plugin-id",
			"namespace",
			"marketplace",
			"status",
			"installed-version",
			"available-version",
			"update",
			"trust",
			"health",
			"diagnostics",
			"disable",
			"upgrade",
			"remove",
		]);

		const disabledSnapshot = withState(snapshot, "zeta@team", "disabled", "1.0.0");
		const disabled = createPluginsCommandFlow({
			snapshot: disabledSnapshot,
			operations: actions,
			selector: "zeta",
		});
		expect(disabled.items.map(({ id }) => id)).toContain("enable");
		expect(disabled.items.map(({ id }) => id)).not.toContain("disable");

		for (const [menu, id, operation] of [
			[enabled, "disable", actions.disable],
			[enabled, "upgrade", actions.upgrade],
			[enabled, "remove", actions.remove],
			[disabled, "enable", actions.enable],
		] as const) {
			const replace = vi.fn();
			await menu.items.find((item) => item.id === id)!.onSelect!({
				push: vi.fn(),
				replace,
				back: vi.fn(),
				close: vi.fn(),
			});
			if (id === "enable" || id === "upgrade") {
				expect(operation).toHaveBeenCalledWith("zeta@team", expect.any(Function));
			} else {
				expect(operation).toHaveBeenCalledWith("zeta@team");
			}
			expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: "plugins" }));
		}
	});

	it("keeps direct installations enableable without offering managed-only actions", () => {
		const snapshot = {
			...pluginSnapshot(),
			plugins: [
				{
					pluginId: "direct-tools@workspace-local" as const,
					displayName: "Direct Tools",
					state: "enabled" as const,
					enabled: true,
					validity: "valid" as const,
					scope: "workspace" as const,
					source: "/workspace/.agents/plugins/direct-tools",
				},
			],
		} satisfies PluginsCommandFlowSnapshot;
		const detail = createPluginsCommandFlow({
			snapshot,
			operations: operations(snapshot),
			selector: "direct-tools@workspace-local",
		});

		expect(detail.items.map(({ id }) => id)).toContain("disable");
		expect(detail.items).toContainEqual(expect.objectContaining({ id: "enabled", description: "yes" }));
		expect(detail.items).toContainEqual(expect.objectContaining({ id: "validity", description: "valid" }));
		expect(detail.items.map(({ id }) => id)).not.toContain("remove");
		expect(detail.items.map(({ id }) => id)).not.toContain("upgrade");
		expect(detail.items).toContainEqual(
			expect.objectContaining({
				id: "package-management",
				description: "Update or remove this Plugin from its package directory",
			}),
		);
	});

	it("offers repair and removal for an invalid managed installation", () => {
		const snapshot = {
			...pluginSnapshot(),
			plugins: [
				{
					pluginId: "broken-tools@team" as const,
					displayName: "Broken Tools",
					state: "invalid" as const,
					enabled: false,
					validity: "invalid" as const,
					actions: ["upgrade", "remove"] as const,
				},
			],
		} satisfies PluginsCommandFlowSnapshot;
		const detail = createPluginsCommandFlow({
			snapshot,
			operations: operations(snapshot),
			selector: "broken-tools@team",
		});

		expect(detail.items.map(({ id }) => id)).toEqual([
			"plugin-id",
			"namespace",
			"marketplace",
			"status",
			"enabled",
			"validity",
			"diagnostics",
			"upgrade",
			"remove",
		]);
	});

	it("shows ambiguous namespace selectors instead of silently returning to browse", () => {
		const snapshot: PluginsCommandFlowSnapshot = {
			...pluginSnapshot(),
			plugins: [
				...pluginSnapshot().plugins,
				{
					pluginId: "alpha@other",
					displayName: "Other Alpha",
					state: "available",
				},
			],
		};
		const flow = createPluginsCommandFlow({ snapshot, operations: operations(snapshot), selector: "alpha" });

		expect(flow).toMatchObject({
			id: "plugins:selector-ambiguous",
			title: "Ambiguous Plugin selector",
		});
		expect(flow.items.map(({ id }) => id)).toEqual(["alpha@other", "alpha@team"]);
		expect(flow.items.every(({ description }) => description?.includes("alpha@"))).toBe(true);
	});

	it("resolves a full PluginId case-sensitively before offering a unique case-folded fallback", () => {
		const snapshot: PluginsCommandFlowSnapshot = {
			...pluginSnapshot(),
			plugins: [
				{ pluginId: "review@Team", displayName: "Upper Team", state: "enabled" },
				{ pluginId: "review@team", displayName: "Lower Team", state: "disabled" },
			],
		};

		const exact = createPluginsCommandFlow({ snapshot, operations: operations(snapshot), selector: "review@team" });
		expect(exact).toMatchObject({ id: "plugins:detail:review@team", title: "Lower Team" });

		const ambiguous = createPluginsCommandFlow({
			snapshot,
			operations: operations(snapshot),
			selector: "REVIEW@TEAM",
		});
		expect(ambiguous).toMatchObject({ id: "plugins:selector-ambiguous", title: "Ambiguous Plugin selector" });
		expect(ambiguous.items.map(({ id }) => id)).toEqual(["review@Team", "review@team"]);
	});

	it("refreshes and renders global diagnostics from the operation's returned snapshot", async () => {
		const before = pluginSnapshot();
		const after = { ...before, revision: "plugins:2", diagnostics: [] } satisfies PluginsCommandFlowSnapshot;
		const actions = operations(before);
		vi.mocked(actions.refresh).mockResolvedValue(after);
		const flow = createPluginsCommandFlow({ snapshot: before, operations: actions });
		const replace = vi.fn();

		await flow.items.find(({ id }) => id === "refresh")!.onSelect!({
			push: vi.fn(),
			replace,
			back: vi.fn(),
			close: vi.fn(),
		});
		expect(actions.refresh).toHaveBeenCalledWith(expect.any(Function));
		expect(replace).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "plugins",
				items: expect.arrayContaining([expect.objectContaining({ id: "diagnostics", description: "0 total" })]),
			}),
		);
	});
});

function pluginSnapshot(): PluginsCommandFlowSnapshot {
	return {
		revision: "plugins:1",
		plugins: [
			{
				pluginId: "zeta@team",
				displayName: "Zeta",
				description: "Review changes",
				state: "update-available",
				installedVersion: "1.0.0",
				availableVersion: "1.1.0",
				updateAvailable: true,
				trust: "untrusted",
				health: "failed-to-start",
			},
			{
				pluginId: "alpha@team",
				displayName: "Alpha",
				state: "available",
				availableVersion: "2.0.0",
			},
		],
		diagnostics: [
			{
				code: "plugin-warning",
				severity: "warning",
				message: "Alpha needs attention",
				pluginId: "alpha@team",
				componentName: "alpha:review",
			},
			{
				code: "plugin-warning",
				severity: "warning",
				message: "Needs attention",
				pluginId: "zeta@team",
				componentName: "zeta:docs",
			},
		],
	};
}

function operations(snapshot: PluginsCommandFlowSnapshot): PluginsCommandFlowOperations {
	return {
		install: vi.fn(async () => snapshot),
		enable: vi.fn(async () => snapshot),
		disable: vi.fn(async () => snapshot),
		upgrade: vi.fn(async () => snapshot),
		remove: vi.fn(async () => snapshot),
		refresh: vi.fn(async () => snapshot),
	};
}

function withState(
	snapshot: PluginsCommandFlowSnapshot,
	pluginId: "alpha@team" | "zeta@team",
	state: "enabled" | "disabled",
	installedVersion: string,
): PluginsCommandFlowSnapshot {
	return {
		...snapshot,
		revision: `${snapshot.revision}:next`,
		plugins: snapshot.plugins.map((plugin) =>
			plugin.pluginId === pluginId ? { ...plugin, state, installedVersion } : plugin,
		),
	};
}
