import type { SkillId, SkillRevision } from "@coda/skills";
import { describe, expect, it, vi } from "vitest";
import {
	autoApproveSkillMcpDependencyInstall,
	createPersistingSkillMcpDependencyCoordinator,
	createSessionSkillMcpDependencyPreparation,
} from "../../src/app/skill-mcp-dependencies.ts";
import type { SettingsStore, UserSettings } from "../../src/settings/types.ts";
import type { ResolvedCodingSkill } from "../../src/skills/types.ts";

function skill(name: string, url = "https://docs.example.test/mcp"): ResolvedCodingSkill {
	const root = "/home/test/.agents/skills";
	const origin = { scope: "user" as const, root, priority: 2 };
	return {
		candidate: {
			id: `skill:${name.padEnd(32, "0").slice(0, 32)}` as SkillId,
			revision: `skill-revision:${name}` as SkillRevision,
			directory: `${root}/${name}`,
			skillFile: `${root}/${name}/SKILL.md`,
			metadata: { name, description: `${name} workflow`, metadata: {} },
			conformant: true,
			provenance: [{ root, origin, depth: 0 }],
			diagnostics: [],
		},
		origin,
		precedence: 2,
		winner: true,
		collisionCount: 1,
		sourceLabel: "~/.agents/skills",
		qualifiedName: name,
		implicitInvocation: true,
		dependencies: { tools: [{ type: "mcp", value: "docs", url }] },
	};
}

function memorySettings(initial: UserSettings): {
	readonly store: SettingsStore;
	readonly current: () => UserSettings;
	readonly replace: (settings: UserSettings) => void;
	readonly save: ReturnType<typeof vi.fn>;
	readonly update: ReturnType<typeof vi.fn>;
} {
	let value = initial;
	const save = vi.fn(async (next: UserSettings) => {
		value = structuredClone(next);
	});
	const update = vi.fn(async (mutator: (settings: UserSettings) => UserSettings) => {
		value = structuredClone(mutator(structuredClone(value)));
		return structuredClone(value);
	});
	return {
		store: { load: async () => structuredClone(value), update, save },
		current: () => structuredClone(value),
		replace: (next) => {
			value = structuredClone(next);
		},
		save,
		update,
	};
}

describe("application Skill MCP dependency coordination", () => {
	it("uses exact interactive choices once per Session and returns the post-refresh Project catalog", async () => {
		const memory = memorySettings({});
		const settings = { current: await memory.store.load() };
		const selected = skill("review");
		const skills = { marker: "after-refresh" } as never;
		const mcpTools = [{ id: "mcp:docs:search" }] as never;
		const selections: unknown[] = [];
		const preparation = createSessionSkillMcpDependencyPreparation({
			settings,
			store: memory.store,
			refreshProject: async () => {
				settings.current = await memory.store.load();
			},
			capabilityCatalogSnapshot: () => ({ revision: "project:after-refresh", skills, mcp: { tools: mcpTools } }),
			approvalPolicy: "on-request",
			sandboxMode: "workspace-write",
			select: async (title, choices) => {
				selections.push({ title, choices });
				return "install";
			},
		});

		const first = await preparation({
			selectedSkills: [selected],
			signal: new AbortController().signal,
		});
		const second = await preparation({
			selectedSkills: [selected],
			signal: new AbortController().signal,
		});

		expect(selections).toEqual([
			{
				title: "Install MCP servers?\n\nThe following MCP servers are required by the selected skills but are not installed yet: docs [https://docs.example.test/mcp; requested by Skill review]. Install them now?",
				choices: [
					{
						id: "install",
						label: "Install",
						description: "Install and enable the missing MCP servers in your global config.",
					},
					{
						id: "continue",
						label: "Continue anyway",
						description: "Skip installation for now and do not show again for these MCP servers in this session.",
					},
				],
			},
		]);
		expect(first).toEqual({ skills, projectRevision: "project:after-refresh", mcpTools });
		expect(second).toEqual(first);
		expect(memory.current().mcpServers).toEqual([
			{ id: "docs", transport: { kind: "http", url: "https://docs.example.test/mcp" } },
		]);
		expect(memory.update).toHaveBeenCalledOnce();
		expect(memory.save).not.toHaveBeenCalled();
	});

	it("persists Skill OAuth callback metadata while reporting authentication as client-managed", async () => {
		const memory = memorySettings({});
		const diagnostics = vi.fn(async () => undefined);
		const selected = {
			...skill("oauth-docs", "https://oauth.example.test/mcp"),
			dependencies: {
				tools: [
					{
						type: "mcp",
						value: "oauth-docs",
						url: "https://oauth.example.test/mcp",
						oauth: { callbackPort: 3118 },
					},
				],
			},
		};
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings: { current: {} },
			store: memory.store,
			refreshProject: async () => undefined,
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await coordinator.prepare({ selectedSkills: [selected], signal: new AbortController().signal });

		expect(memory.current().mcpServers).toEqual([
			{
				id: "oauth-docs",
				transport: { kind: "http", url: "https://oauth.example.test/mcp" },
				oauth: { callbackPort: 3118 },
			},
		]);
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-oauth-client-managed" }),
		);
	});

	it("auto-approval takes precedence over interactive prompting and reads the live permission state", async () => {
		const memory = memorySettings({});
		const settings = { current: await memory.store.load() };
		let approvalPolicy: "never" | "on-request" = "never";
		let sandboxMode: "danger-full-access" | "workspace-write" = "danger-full-access";
		const select = vi.fn(async () => "continue");
		const preparation = createSessionSkillMcpDependencyPreparation({
			settings,
			store: memory.store,
			refreshProject: async () => {
				settings.current = await memory.store.load();
			},
			capabilityCatalogSnapshot: () => ({
				revision: "project:live-policy",
				skills: {} as never,
				mcp: { tools: [] },
			}),
			approvalPolicy: () => approvalPolicy,
			sandboxMode: () => sandboxMode,
			select,
		});

		await preparation({ selectedSkills: [skill("review")], signal: new AbortController().signal });
		approvalPolicy = "on-request";
		sandboxMode = "workspace-write";
		const other = {
			...skill("search", "https://search.example.test/mcp"),
			dependencies: {
				tools: [{ type: "mcp", value: "search", url: "https://search.example.test/mcp" }],
			},
		};
		await preparation({ selectedSkills: [other], signal: new AbortController().signal });

		expect(select).toHaveBeenCalledOnce();
		expect(memory.current().mcpServers).toEqual([
			{ id: "docs", transport: { kind: "http", url: "https://docs.example.test/mcp" } },
		]);
	});

	it("requires explicit consent before a Workspace Agent Plugin Skill can install an executable dependency", async () => {
		const memory = memorySettings({});
		const settings = { current: await memory.store.load() };
		const diagnostics = vi.fn(async () => undefined);
		const pluginRoot = "/workspace/.agents/plugins/review-tools";
		const pluginSkill = {
			...skill("review"),
			origin: {
				scope: "workspace" as const,
				root: pluginRoot,
				priority: 1,
				kind: "plugin" as const,
				pluginName: "review-tools",
				pluginRoot,
			},
			sourceLabel: "review-tools@workspace-local",
			qualifiedName: "review-tools:review",
			dependencies: {
				tools: [{ type: "mcp", value: "local", transport: "stdio", command: "./bin/server" }],
			},
		};
		const preparation = createSessionSkillMcpDependencyPreparation({
			settings,
			store: memory.store,
			refreshProject: async () => undefined,
			capabilityCatalogSnapshot: () => ({
				revision: "project:workspace-plugin",
				skills: {} as never,
				mcp: { tools: [] },
			}),
			approvalPolicy: "never",
			sandboxMode: "danger-full-access",
			reportDiagnostic: diagnostics,
		});

		await preparation({ selectedSkills: [pluginSkill], signal: new AbortController().signal });

		expect(memory.current().mcpServers).toBeUndefined();
		expect(memory.update).not.toHaveBeenCalled();
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-not-installed", dependency: expect.any(String) }),
		);
	});

	it("counts disabled user and untrusted Workspace configurations as already installed", async () => {
		const memory = memorySettings({
			mcpServers: [
				{
					id: "disabled-docs",
					enabled: false,
					transport: { kind: "http", url: "https://disabled.example.test/mcp" },
				},
			],
		});
		const settings = { current: await memory.store.load() };
		const select = vi.fn(async () => "install");
		const preparation = createSessionSkillMcpDependencyPreparation({
			settings,
			store: memory.store,
			refreshProject: async () => undefined,
			configuredServers: () => [
				...(settings.current.mcpServers ?? []),
				{
					id: "workspace-docs",
					transport: { kind: "http" as const, url: "https://docs.example.test/mcp" },
				},
			],
			capabilityCatalogSnapshot: () => ({ revision: "project:configured", skills: {} as never, mcp: { tools: [] } }),
			approvalPolicy: "on-request",
			sandboxMode: "workspace-write",
			select,
		});

		await preparation({ selectedSkills: [skill("review")], signal: new AbortController().signal });
		await preparation({
			selectedSkills: [skill("disabled", "https://disabled.example.test/mcp")],
			signal: new AbortController().signal,
		});

		expect(select).not.toHaveBeenCalled();
		expect(memory.save).not.toHaveBeenCalled();
	});

	it("auto-installs headlessly only with never approval and unrestricted confinement", async () => {
		const run = async (approvalPolicy: "never" | "on-request", sandboxMode: "danger-full-access") => {
			const memory = memorySettings({});
			const settings = { current: await memory.store.load() };
			const diagnosticCodes: string[] = [];
			const preparation = createSessionSkillMcpDependencyPreparation({
				settings,
				store: memory.store,
				refreshProject: async () => {
					settings.current = await memory.store.load();
				},
				capabilityCatalogSnapshot: () => ({
					revision: "project:headless",
					skills: {} as never,
					mcp: { tools: [] },
				}),
				approvalPolicy,
				sandboxMode,
				reportDiagnostic: (diagnostic) => {
					diagnosticCodes.push(diagnostic.code);
				},
			});
			await preparation({ selectedSkills: [skill("review")], signal: new AbortController().signal });
			return {
				persisted: memory.current().mcpServers,
				updates: memory.update.mock.calls.length,
				saves: memory.save.mock.calls.length,
				diagnosticCodes,
			};
		};

		await expect(run("never", "danger-full-access")).resolves.toMatchObject({
			persisted: [{ id: "docs" }],
			updates: 1,
			saves: 0,
			diagnosticCodes: [],
		});
		await expect(run("on-request", "danger-full-access")).resolves.toEqual({
			persisted: undefined,
			updates: 0,
			saves: 0,
			diagnosticCodes: ["skill-mcp-dependency-not-installed"],
		});
	});

	it("auto-approves only Codex's never + unrestricted permission combination", () => {
		expect(autoApproveSkillMcpDependencyInstall("never", "danger-full-access")).toBe(true);
		expect(autoApproveSkillMcpDependencyInstall("never", "workspace-write")).toBe(false);
		expect(autoApproveSkillMcpDependencyInstall("never", "read-only")).toBe(false);
		expect(autoApproveSkillMcpDependencyInstall("on-request", "danger-full-access")).toBe(false);
		expect(autoApproveSkillMcpDependencyInstall("untrusted", "danger-full-access")).toBe(false);
	});

	it("persists an accepted missing server and refreshes the coherent Project catalog", async () => {
		const memory = memorySettings({ plugins: { "review@personal": { enabled: true } } });
		const settings = { current: await memory.store.load() };
		const refreshProject = vi.fn(async () => {
			settings.current = await memory.store.load();
		});
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings,
			store: memory.store,
			refreshProject,
			decide: async () => "install",
		});

		await coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal });

		expect(memory.current()).toEqual({
			plugins: { "review@personal": { enabled: true } },
			mcpServers: [{ id: "docs", transport: { kind: "http", url: "https://docs.example.test/mcp" } }],
		});
		expect(settings.current).toEqual(memory.current());
		expect(refreshProject).toHaveBeenCalledOnce();
	});

	it("treats a successful Project refresh as the commit point even if the prompt signal aborts", async () => {
		const memory = memorySettings({});
		const settings = { current: await memory.store.load() };
		const controller = new AbortController();
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings,
			store: memory.store,
			refreshProject: async () => {
				settings.current = await memory.store.load();
				controller.abort();
			},
			decide: async () => "install",
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: controller.signal }),
		).resolves.toMatchObject({ outcome: "installed" });
		expect(memory.current().mcpServers).toEqual([
			{ id: "docs", transport: { kind: "http", url: "https://docs.example.test/mcp" } },
		]);
		expect(settings.current).toEqual(memory.current());
	});

	it("never overwrites a same-name server introduced after planning", async () => {
		const memory = memorySettings({});
		const settings = { current: {} };
		const diagnostics = vi.fn(async () => undefined);
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings,
			store: memory.store,
			refreshProject: vi.fn(async () => undefined),
			decide: async () => {
				memory.replace({
					mcpServers: [{ id: "docs", transport: { kind: "http", url: "https://other.example.test/mcp" } }],
				});
				return "install";
			},
			reportDiagnostic: diagnostics,
		});

		await coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal });

		expect(memory.current().mcpServers).toEqual([
			{ id: "docs", transport: { kind: "http", url: "https://other.example.test/mcp" } },
		]);
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-install-conflict" }),
		);
	});

	it("warns and continues after a failed Project refresh is rolled back to a known state", async () => {
		const memory = memorySettings({ plugins: { "review@personal": { enabled: true } } });
		const settings = { current: await memory.store.load() };
		const diagnostics = vi.fn(async () => undefined);
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings,
			store: memory.store,
			refreshProject: async () => {
				const committed = await memory.store.load();
				memory.replace({ ...committed, plugins: { "review@personal": { enabled: false } } });
				throw new Error("refresh failed");
			},
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "continued" });

		expect(memory.current()).toEqual({ plugins: { "review@personal": { enabled: false } }, mcpServers: [] });
		expect(settings.current).toEqual(memory.current());
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-install-failed", severity: "warning" }),
		);
	});

	it("warns and continues when settings cannot be loaded before installation", async () => {
		const diagnostics = vi.fn(async () => undefined);
		const save = vi.fn(async () => undefined);
		const refreshProject = vi.fn(async () => undefined);
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings: { current: {} },
			store: {
				load: async () => {
					throw new Error("settings unavailable");
				},
				save,
			},
			refreshProject,
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "continued" });
		expect(save).not.toHaveBeenCalled();
		expect(refreshProject).not.toHaveBeenCalled();
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-install-failed", severity: "warning" }),
		);
	});

	it("warns and continues when failed persistence reconciles to the unchanged settings", async () => {
		const diagnostics = vi.fn(async () => undefined);
		const refreshProject = vi.fn(async () => undefined);
		const store: SettingsStore = {
			load: async () => ({}),
			save: async () => {
				throw new Error("settings write failed before commit");
			},
		};
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings: { current: {} },
			store,
			refreshProject,
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "continued" });
		expect(refreshProject).not.toHaveBeenCalled();
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-install-failed", severity: "warning" }),
		);
	});

	it("rolls back a persistence error that happened after commit and continues", async () => {
		let persisted: UserSettings = {};
		let saveCount = 0;
		const diagnostics = vi.fn(async () => undefined);
		const store: SettingsStore = {
			load: async () => structuredClone(persisted),
			save: async (next) => {
				saveCount++;
				persisted = structuredClone(next);
				if (saveCount === 1) throw new Error("permissions failed after commit");
			},
		};
		const settings = { current: {} };
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings,
			store,
			refreshProject: vi.fn(async () => undefined),
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "continued" });
		expect(persisted.mcpServers).toEqual([]);
		expect(settings.current).toEqual(persisted);
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-install-failed", severity: "warning" }),
		);
	});

	it("fails closed when refresh rollback cannot establish a known settings state", async () => {
		let persisted: UserSettings = {};
		let saveCount = 0;
		const diagnostics = vi.fn(async () => undefined);
		const store: SettingsStore = {
			load: async () => structuredClone(persisted),
			save: async (next) => {
				saveCount++;
				if (saveCount === 2) throw new Error("rollback unavailable");
				persisted = structuredClone(next);
			},
		};
		const coordinator = createPersistingSkillMcpDependencyCoordinator({
			settings: { current: {} },
			store,
			refreshProject: async () => {
				throw new Error("refresh failed");
			},
			decide: async () => "install",
			reportDiagnostic: diagnostics,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [skill("review")], signal: new AbortController().signal }),
		).rejects.toThrow("MCP dependency installation rollback failed");
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-rollback-failed", severity: "error" }),
		);
	});
});
