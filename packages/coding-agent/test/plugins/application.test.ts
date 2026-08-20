import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import type { McpConnector } from "@coda/mcp";
import { createSystemScheduler, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ApplicationPluginActiveCatalog,
	createApplicationPluginServices,
} from "../../src/app/plugin-management.ts";
import { type ApplicationOutput, createCodingAgentApplication } from "../../src/application.ts";
import type { FileSystem } from "../../src/host/file-system.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../../src/host/node-process-runner.ts";
import type { ProcessRunner } from "../../src/host/process-runner.ts";
import { createCodingPluginsManager } from "../../src/plugins/inventory.ts";
import type { UserSettings } from "../../src/settings/types.ts";
import { testTimeRuntime } from "../time-runtime.ts";

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}

	take(): string {
		const value = this.value;
		this.value = "";
		return value;
	}
}

const temporary: string[] = [];

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition did not become true");
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function applicationFixture(
	options: {
		readonly fileSystem?: FileSystem;
		readonly processRunner?: ProcessRunner;
		readonly mcpConnector?: McpConnector;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "coda-plugin-application-"));
	temporary.push(root);
	const workspace = join(root, "workspace");
	const homeDirectory = join(root, "home");
	await mkdir(workspace, { recursive: true });
	await mkdir(homeDirectory, { recursive: true });
	const models = createModels({ runtime: testTimeRuntime() });
	const getAuth = vi.spyOn(models, "getAuth");
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let settings: UserSettings = {};
	let id = 0;
	const application = createCodingAgentApplication({
		models,
		...(options.mcpConnector ? { mcpConnector: options.mcpConnector } : {}),
		settings: {
			load: async () => settings,
			save: async (next) => {
				settings = next;
			},
		},
		fileSystem: options.fileSystem ?? createNodeFileSystem(),
		processRunner: options.processRunner ?? createNodeProcessRunner({ platform: "darwin" }),
		io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
		runtime: {
			cwd: workspace,
			homeDirectory,
			platform: "darwin",
			environment: { PATH: process.env.PATH, ABSENT: undefined },
			clock: { now: () => 0 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		},
	});
	return { application, getAuth, homeDirectory, models, settings: () => settings, stderr, stdout, workspace };
}

async function writeMarketplace(root: string): Promise<string> {
	const marketplaceRoot = join(root, ".agents", "plugins");
	const pluginRoot = join(marketplaceRoot, "packages", "review-tools");
	await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
	await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
	await writeFile(
		join(pluginRoot, "plugin.json"),
		JSON.stringify({
			$schema: AGENT_PLUGIN_SCHEMA,
			name: "review-tools",
			version: "1.0.0",
			description: "Review local changes",
		}),
	);
	await writeFile(
		join(pluginRoot, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Review local changes\n---\n\nReview carefully.\n",
	);
	await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ poisoned: true }));
	await writeFile(
		join(marketplaceRoot, "marketplace.json"),
		JSON.stringify({
			name: "team-market",
			plugins: [{ name: "review-tools", source: "./packages/review-tools" }],
		}),
	);
	return root;
}

describe("Plugin application integration", () => {
	it("returns a versioned committed JSON result when Marketplace post-processing fails", async () => {
		const source = await mkdtemp(join(tmpdir(), "coda-plugin-marketplace-post-commit-"));
		temporary.push(source);
		await writeMarketplace(source);
		const revision = "c".repeat(40);
		const revisions = new Map<string, string>();
		const processRunner: ProcessRunner = {
			run: async (request) => {
				if (request.args[0] === "clone") {
					const destination = request.args.at(-1)!;
					await cp(source, destination, { recursive: true });
					revisions.set(destination, revision);
					return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
				}
				if (request.args[2] === "rev-parse") {
					return {
						exitCode: 0,
						signal: null,
						stdout: `${revisions.get(request.args[1]!) ?? revision}\n`,
						stderr: "",
						timedOut: false,
						truncated: false,
					};
				}
				return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
			},
		};
		const base = createNodeFileSystem();
		let failMetadataCleanup = true;
		const value = await applicationFixture({
			fileSystem: {
				...base,
				lstat: async (path) => {
					if (failMetadataCleanup && path.endsWith(`${sep}.git`)) {
						throw new Error("Marketplace metadata cleanup unavailable");
					}
					return base.lstat(path);
				},
			},
			processRunner,
		});

		await expect(
			value.application.run(["plugin", "marketplace", "add", "https://example.test/marketplace.git", "--json"]),
		).resolves.toBe(1);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_post_commit_failed",
			operation: "marketplace-add",
			committed: true,
			revision: expect.stringMatching(/^plugins:/u),
		});
		expect(value.stderr.value).toBe("");
		expect(value.getAuth).not.toHaveBeenCalled();

		failMetadataCleanup = false;
		await expect(value.application.run(["plugin", "marketplace", "list", "--json"])).resolves.toBe(0);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			type: "plugin_marketplace_list",
			marketplaces: [{ name: "team-market", revision }],
		});
	});

	it("runs the headless Marketplace and Plugin lifecycle without selecting or authenticating a Model", async () => {
		const value = await applicationFixture();
		const marketplace = await writeMarketplace(join(value.workspace, "marketplace"));

		await expect(value.application.run(["plugin", "marketplace", "add", marketplace, "--json"])).resolves.toBe(0);
		const addedMarketplace = JSON.parse(value.stdout.take());
		expect(addedMarketplace).toMatchObject({
			schemaVersion: 1,
			type: "plugin_marketplace_operation",
			operation: "add",
			marketplaces: [{ name: "team-market", status: "available" }],
		});

		await expect(value.application.run(["plugin", "add", "review-tools@team-market", "--json"])).resolves.toBe(0);
		const installed = JSON.parse(value.stdout.take());
		expect(installed).toMatchObject({
			schemaVersion: 1,
			type: "plugin_operation",
			operation: "add",
			plugin: { pluginId: "review-tools@team-market", state: "enabled" },
		});
		expect(value.settings().plugins).toEqual({ "review-tools@team-market": { enabled: true } });

		await expect(value.application.run(["plugin", "inspect", "review-tools@team-market", "--json"])).resolves.toBe(0);
		const inspected = JSON.parse(value.stdout.take());
		expect(inspected).toMatchObject({
			schemaVersion: 1,
			type: "plugin_inspect",
			plugin: {
				pluginId: "review-tools@team-market",
				namespace: "review-tools",
				scope: "user",
				installedVersion: "1.0.0",
				source: { source: "local" },
				contributions: { skills: ["review-tools:review"], mcpServers: [] },
				trust: "not-required",
				selectedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				selectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
			},
			diagnostics: [],
		});
		await expect(value.application.run(["plugin", "inspect", "review-tools@team-market"])).resolves.toBe(0);
		const inspectedText = value.stdout.take();
		expect(inspectedText).toContain("Enabled: yes\n");
		expect(inspectedText).toContain("Validity: valid\n");
		expect(inspectedText).toContain("Source: ");
		expect(inspectedText).toMatch(/Selected digest: [a-f0-9]{64}\n/u);
		expect(inspectedText).toMatch(/Selected revision: [a-f0-9]{64}\n/u);
		expect(inspectedText).toMatch(/Available revision: [a-f0-9]{64}\n/u);
		expect(inspectedText).toContain("Update: current\n");

		await expect(value.application.run(["plugin", "disable", "review-tools@team-market", "--json"])).resolves.toBe(0);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			type: "plugin_operation",
			operation: "disable",
			plugin: { pluginId: "review-tools@team-market", state: "installed", enabled: false },
		});
		await expect(value.application.run(["plugin", "add", "review-tools@team-market", "--json"])).resolves.toBe(1);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_already_installed",
			operation: "add",
			pluginId: "review-tools@team-market",
			committed: false,
			message:
				'Plugin is already installed: review-tools@team-market. Use "plugin upgrade review-tools@team-market" to update it or "plugin enable review-tools@team-market" to enable it.',
		});
		expect(value.settings().plugins).toEqual({ "review-tools@team-market": { enabled: false } });
		await expect(value.application.run(["plugin", "enable", "review-tools@team-market", "--json"])).resolves.toBe(0);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			type: "plugin_operation",
			operation: "enable",
			plugin: { pluginId: "review-tools@team-market", state: "enabled", enabled: true },
		});
		await expect(value.application.run(["plugin", "upgrade", "review-tools@team-market", "--json"])).resolves.toBe(0);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			type: "plugin_operation",
			operation: "upgrade",
			plugin: { pluginId: "review-tools@team-market", state: "enabled" },
		});
		await expect(value.application.run(["plugin", "disable", "review-tools@team-market"])).resolves.toBe(0);
		expect(value.stdout.take()).toBe("Disabled review-tools@team-market\n");
		await expect(value.application.run(["plugin", "enable", "review-tools@team-market"])).resolves.toBe(0);
		expect(value.stdout.take()).toBe("Enabled review-tools@team-market\n");
		await expect(value.application.run(["plugin", "upgrade", "review-tools@team-market"])).resolves.toBe(0);
		expect(value.stdout.take()).toBe("Upgraded review-tools@team-market\n");

		await expect(value.application.run(["plugin", "list", "--available", "--json"])).resolves.toBe(0);
		const listed = JSON.parse(value.stdout.take());
		expect(listed).toMatchObject({
			schemaVersion: 1,
			type: "plugin_list",
			installed: [{ pluginId: "review-tools@team-market", state: "enabled" }],
			available: [],
		});
		await expect(value.application.run(["plugin", "inspect", "missing@team-market", "--json"])).resolves.toBe(1);
		expect(JSON.parse(value.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_not_found",
			operation: "inspect",
			pluginId: "missing@team-market",
			committed: false,
		});
		expect(value.getAuth).not.toHaveBeenCalled();
		expect(value.stderr.value).toBe("");

		const installationState = JSON.parse(
			await readFile(
				join(value.homeDirectory, ".coda", "plugins", "installations", "installations.v1.json"),
				"utf8",
			),
		);
		const selectedRoot = installationState.installations[0].selectedRoot as string;
		await expect(readFile(join(selectedRoot, "plugin.json"), "utf8")).resolves.toContain(AGENT_PLUGIN_SCHEMA);
		await expect(readFile(join(selectedRoot, ".codex-plugin", "plugin.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const faux = fauxProvider({ runtime: testTimeRuntime(10) });
		faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("<plugins_instructions>");
				expect(context.systemPrompt).toContain("review-tools:review");
				expect(JSON.stringify(context.messages)).toContain("Review carefully.");
				return fauxAssistantMessage("managed Plugin visible", { timestamp: 10 });
			},
		]);
		value.models.setProvider(faux.provider);
		const printExit = await value.application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"$review-tools:review inspect this",
		]);
		expect(value.stderr.value).toBe("");
		expect(printExit).toBe(0);
		expect(value.stdout.take()).toBe("managed Plugin visible\n");
	});

	it("preserves stable component diagnostics in JSON and filters them by managed installation ID", async () => {
		const value = await applicationFixture();
		const marketplace = join(value.workspace, "diagnostic-marketplace");
		const marketplaceRoot = join(marketplace, ".agents", "plugins");
		const reviewRoot = join(marketplaceRoot, "packages", "review-tools");
		const lintRoot = join(marketplaceRoot, "packages", "lint-tools");
		await Promise.all([
			mkdir(join(reviewRoot, "skills", "alpha"), { recursive: true }),
			mkdir(join(reviewRoot, "skills", "beta"), { recursive: true }),
			mkdir(join(lintRoot, "skills", "other"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(
				join(reviewRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", version: "1.0.0" }),
			),
			writeFile(
				join(reviewRoot, "skills", "alpha", "SKILL.md"),
				"---\nname: different-alpha\ndescription: Invalid alpha\n---\n\nInvalid.\n",
			),
			writeFile(
				join(reviewRoot, "skills", "beta", "SKILL.md"),
				"---\nname: different-beta\ndescription: Invalid beta\n---\n\nInvalid.\n",
			),
			writeFile(
				join(reviewRoot, "mcp.json"),
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: {
						docs: { type: "stdio", command: "/absolute/docs" },
						search: { type: "unknown", command: "runner" },
					},
				}),
			),
			writeFile(
				join(lintRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "lint-tools", version: "1.0.0" }),
			),
			writeFile(
				join(lintRoot, "skills", "other", "SKILL.md"),
				"---\nname: different-other\ndescription: Invalid other\n---\n\nInvalid.\n",
			),
			writeFile(
				join(marketplaceRoot, "marketplace.json"),
				JSON.stringify({
					name: "team-market",
					plugins: [
						{ name: "review-tools", source: "./packages/review-tools" },
						{ name: "lint-tools", source: "./packages/lint-tools" },
					],
				}),
			),
		]);

		await expect(value.application.run(["plugin", "marketplace", "add", marketplace, "--json"])).resolves.toBe(0);
		value.stdout.take();
		await expect(value.application.run(["plugin", "add", "review-tools@team-market", "--json"])).resolves.toBe(0);
		value.stdout.take();
		await expect(value.application.run(["plugin", "inspect", "review-tools@team-market", "--json"])).resolves.toBe(0);
		const inspected = JSON.parse(value.stdout.take());
		const componentNames = [
			...new Set(inspected.diagnostics.map((entry: { componentName?: string }) => entry.componentName)),
		]
			.filter((entry): entry is string => entry !== undefined)
			.sort();

		expect(componentNames).toEqual([
			"review-tools:alpha",
			"review-tools:beta",
			"review-tools:docs",
			"review-tools:search",
		]);
		expect(inspected.diagnostics).not.toContainEqual(expect.objectContaining({ pluginId: "lint-tools@team-market" }));
		expect(
			inspected.diagnostics.every((entry: { pluginId?: string }) => entry.pluginId === "review-tools@team-market"),
		).toBe(true);
		await expect(value.application.run(["plugin", "inspect", "review-tools@team-market"])).resolves.toBe(0);
		const inspectedText = value.stdout.take();
		for (const componentName of componentNames) expect(inspectedText).toContain(`${componentName}: `);
		expect(inspectedText).not.toContain("lint-tools:other");
	});

	it("rejects a symlink-swapped managed revision before application inventory or MCP startup reads it", async () => {
		const outsideRoot = await mkdtemp(join(tmpdir(), "coda-plugin-external-cache-"));
		temporary.push(outsideRoot);
		await mkdir(join(outsideRoot, "skills", "review"), { recursive: true });
		await writeFile(
			join(outsideRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", version: "9.9.9" }),
		);
		await writeFile(
			join(outsideRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: External poisoned Skill\n---\n\nNever load this.\n",
		);
		await writeFile(
			join(outsideRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { escaped: { command: "outside-plugin-process" } },
			}),
		);
		const base = createNodeFileSystem();
		let selectedRoot: string | undefined;
		let forbiddenPackageProbes = 0;
		const forbidden = (path: string): boolean =>
			path === outsideRoot ||
			path.startsWith(`${outsideRoot}${sep}`) ||
			(selectedRoot !== undefined && (path === selectedRoot || path.startsWith(`${selectedRoot}${sep}`)));
		const rejectProbe = (path: string): never => {
			forbiddenPackageProbes++;
			throw new Error(`Managed external package was probed: ${path}`);
		};
		const fileSystem: FileSystem = {
			...base,
			realpath: async (path) => (forbidden(path) ? rejectProbe(path) : base.realpath(path)),
			stat: async (path) => (forbidden(path) ? rejectProbe(path) : base.stat(path)),
			readDirectory: async (path) => (forbidden(path) ? rejectProbe(path) : base.readDirectory(path)),
			readFile: async (path) => (forbidden(path) ? rejectProbe(path) : base.readFile(path)),
		};
		let connectionAttempts = 0;
		const value = await applicationFixture({
			fileSystem,
			mcpConnector: {
				connect: async () => {
					connectionAttempts++;
					throw new Error("Managed external MCP must not start");
				},
			},
		});
		const marketplace = await writeMarketplace(join(value.workspace, "marketplace"));
		await expect(value.application.run(["plugin", "marketplace", "add", marketplace, "--json"])).resolves.toBe(0);
		value.stdout.take();
		await expect(value.application.run(["plugin", "add", "review-tools@team-market", "--json"])).resolves.toBe(0);
		value.stdout.take();
		const state = JSON.parse(
			await readFile(
				join(value.homeDirectory, ".coda", "plugins", "installations", "installations.v1.json"),
				"utf8",
			),
		);
		selectedRoot = state.installations[0].selectedRoot as string;
		await rm(selectedRoot, { recursive: true, force: true });
		await symlink(outsideRoot, selectedRoot, "dir");

		await expect(value.application.run(["plugin", "inspect", "review-tools@team-market", "--json"])).resolves.toBe(0);
		const inspected = JSON.parse(value.stdout.take());
		expect(inspected).toMatchObject({
			type: "plugin_inspect",
			plugin: {
				pluginId: "review-tools@team-market",
				state: "invalid",
				invalid: true,
				contributions: { skills: [], mcpServers: [] },
			},
			diagnostics: [expect.objectContaining({ code: "plugin-installation-root-invalid" })],
		});
		expect(inspected.diagnostics).not.toContainEqual(
			expect.objectContaining({ pluginId: "review-tools@user-local" }),
		);
		await expect(value.application.run(["plugin", "list", "--available", "--json"])).resolves.toBe(0);
		const listed = JSON.parse(value.stdout.take());
		expect(listed.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-installation-root-invalid",
				pluginId: "review-tools@team-market",
			}),
		);
		expect(listed.diagnostics).not.toContainEqual(expect.objectContaining({ pluginId: "review-tools@user-local" }));
		const faux = fauxProvider({ runtime: testTimeRuntime(12) });
		faux.setResponses([fauxAssistantMessage("safe inventory", { timestamp: 12 })]);
		value.models.setProvider(faux.provider);
		await expect(
			value.application.run([
				"--print",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"inspect safely",
			]),
		).resolves.toBe(0);

		expect(value.stdout.take()).toBe("safe inventory\n");
		expect(connectionAttempts).toBe(0);
		expect(forbiddenPackageProbes).toBe(0);
	});

	it("publishes a disabled managed Plugin out of the next runtime inventory before the operation returns", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-active-project-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		let settings: UserSettings = {};
		let id = 0;
		const fileSystem = createNodeFileSystem();
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: { PATH: process.env.PATH, OMITTED: undefined },
			fileSystem,
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		await services.management.install("review-tools@team-market");
		const manager = createCodingPluginsManager({
			workspace,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
			enablement: settings.plugins ?? {},
			managedInstallations: (await services.installationStore.list()).installations,
			verifyManagedInstallation: (record, options) => services.installationStore.verify(record, options),
		});
		let inventory = await manager.refresh();
		expect(inventory.plugins.map(({ installationId }) => installationId)).toEqual(["review-tools@team-market"]);
		const publicationOrder: string[] = [];
		const deactivate = services.activateProjectRefresh(
			async () => {
				publicationOrder.push("refresh");
				inventory = await manager.refresh({
					enablement: settings.plugins ?? {},
					managedInstallations: (await services.installationStore.list()).installations,
				});
			},
			undefined,
			undefined,
			() => publicationOrder.push("dirty"),
		);

		try {
			const disabled = await services.command.disable("review-tools@team-market");
			expect(disabled.plugins[0]).toMatchObject({ state: "disabled" });
			expect(inventory.plugins).toEqual([]);
			expect(publicationOrder).toEqual(["dirty", "refresh"]);
			await expect(services.command.install("review-tools@team-market")).rejects.toMatchObject({
				name: "CodingPluginAlreadyInstalledError",
				code: "plugin_already_installed",
				committed: false,
				pluginId: "review-tools@team-market",
			});
			expect(settings.plugins).toEqual({ "review-tools@team-market": { enabled: false } });
			expect(inventory.plugins).toEqual([]);
			expect(publicationOrder).toEqual(["dirty", "refresh"]);
			const selected = (await services.installationStore.list()).installations[0]!;
			await writeFile(join(selected.selectedRoot, "plugin.json"), JSON.stringify({ name: "review-tools" }));
			const invalid = await services.command.snapshot();
			expect(invalid.plugins[0]).toMatchObject({
				pluginId: "review-tools@team-market",
				state: "invalid",
				validity: "invalid",
				actions: ["upgrade", "remove"],
			});
		} finally {
			deactivate();
		}
	});

	it("reports a committed lifecycle change as a versioned JSON error when runtime notification fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-json-notification-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		let settings: UserSettings = {};
		let id = 0;
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		await services.management.install("review-tools@team-market");
		let refreshAttempts = 0;
		const deactivate = services.activateProjectRefresh(
			async () => {
				refreshAttempts++;
			},
			undefined,
			workspace,
			() => {
				throw new Error("runtime dirty marker unavailable");
			},
		);
		const stdout = new BufferOutput();

		try {
			await expect(
				services.dispatch(
					{
						command: "disable",
						pluginId: "review-tools@team-market",
						pluginName: "review-tools",
						marketplaceName: "team-market",
						json: true,
					},
					{ stdout },
				),
			).resolves.toBe(1);
			const failure = JSON.parse(stdout.take());
			expect(failure).toMatchObject({
				schemaVersion: 1,
				type: "plugin_error",
				code: "plugin_change_notification_failed",
				operation: "disable",
				pluginId: "review-tools@team-market",
				committed: true,
				revision: expect.stringMatching(/^plugins:/u),
			});
			expect(failure.message).toContain("runtime refresh notification failed");
			expect(settings.plugins).toEqual({ "review-tools@team-market": { enabled: false } });
			expect(refreshAttempts).toBe(1);
		} finally {
			deactivate();
		}
	});

	it("reports a committed Marketplace removal through the versioned JSON error envelope", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-marketplace-remove-notification-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		let settings: UserSettings = {};
		let id = 0;
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		const deactivate = services.activateProjectRefresh(async () => {
			throw new Error("removed Marketplace runtime publication unavailable");
		});
		const stdout = new BufferOutput();

		try {
			await expect(
				services.dispatch(
					{ command: "marketplace-remove", marketplaceName: "team-market", json: true },
					{ stdout },
				),
			).resolves.toBe(1);
			expect(JSON.parse(stdout.take())).toMatchObject({
				schemaVersion: 1,
				type: "plugin_error",
				code: "plugin_post_commit_failed",
				operation: "marketplace-remove",
				committed: true,
				revision: expect.stringMatching(/^plugins:/u),
			});
		} finally {
			deactivate();
		}
		await expect(services.management.marketplaceList()).resolves.toMatchObject({ marketplaces: [], plugins: [] });
	});

	it("reports a failed install rollback through the committed JSON error envelope", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-install-rollback-envelope-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		const base = createNodeFileSystem();
		let installationStateWrites = 0;
		let installationStateUnreadable = false;
		let failSettingsSave = false;
		let settings: UserSettings = {};
		let id = 0;
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (installationStateUnreadable && path.endsWith(`${sep}installations.v1.json`)) {
						throw new Error("installation state unreadable");
					}
					return base.readFile(path);
				},
				rename: async (source, destination) => {
					if (destination.endsWith(`${sep}installations.v1.json`) && ++installationStateWrites === 2) {
						installationStateUnreadable = true;
						throw new Error("installation rollback unavailable");
					}
					return base.rename(source, destination);
				},
			},
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					if (failSettingsSave) throw new Error("settings persistence unavailable");
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		failSettingsSave = true;
		const stdout = new BufferOutput();

		await expect(
			services.dispatch(
				{
					command: "add",
					pluginId: "review-tools@team-market",
					pluginName: "review-tools",
					marketplaceName: "team-market",
					json: true,
				},
				{ stdout },
			),
		).resolves.toBe(1);
		expect(JSON.parse(stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_post_commit_failed",
			operation: "add",
			pluginId: "review-tools@team-market",
			committed: true,
			revision: expect.stringMatching(/^plugins:/u),
			diagnostics: [
				expect.objectContaining({
					code: "plugin-post-commit-projection-failed",
					pluginId: "review-tools@team-market",
				}),
				expect.objectContaining({
					code: "plugin-rollback-failed",
					pluginId: "review-tools@team-market",
				}),
			],
		});
		installationStateUnreadable = false;
		failSettingsSave = false;
		await expect(services.command.snapshot()).resolves.toMatchObject({
			plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state: "enabled" })],
		});
	});

	it("reports a managed commit when effective projection fails and retries dirty notification best-effort", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-managed-projection-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		let settings: UserSettings = {};
		let projectionUnavailable = false;
		let id = 0;
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => {
					if (projectionUnavailable) throw new Error("effective Plugin projection unavailable");
					return settings;
				},
				save: async (next) => {
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		await services.management.install("review-tools@team-market");
		let dirtyCount = 0;
		let refreshCount = 0;
		const deactivate = services.activateProjectRefresh(
			async () => {
				refreshCount++;
				projectionUnavailable = true;
			},
			undefined,
			workspace,
			() => dirtyCount++,
		);
		const stdout = new BufferOutput();

		try {
			await expect(
				services.dispatch(
					{
						command: "disable",
						pluginId: "review-tools@team-market",
						pluginName: "review-tools",
						marketplaceName: "team-market",
						json: true,
					},
					{ stdout },
				),
			).resolves.toBe(1);
			const failure = JSON.parse(stdout.take());
			expect(failure).toMatchObject({
				type: "plugin_error",
				code: "plugin_post_commit_failed",
				operation: "disable",
				pluginId: "review-tools@team-market",
				committed: true,
				revision: expect.stringMatching(/^plugins:/u),
			});
			expect(settings.plugins).toEqual({ "review-tools@team-market": { enabled: false } });
			expect(dirtyCount).toBeGreaterThanOrEqual(2);
			expect(refreshCount).toBeGreaterThanOrEqual(2);
		} finally {
			projectionUnavailable = false;
			deactivate();
		}
		await expect(services.command.snapshot()).resolves.toMatchObject({
			plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state: "disabled" })],
		});
	});

	it("projects committed direct enablement from durable settings when the active runtime refresh fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-direct-notification-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		const pluginRoot = join(workspace, ".agents", "plugins", "direct-tools");
		await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(homeDirectory)]);
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "direct-tools", version: "1.0.0" }),
		);
		let settings: UserSettings = {};
		let id = 0;
		const fileSystem = createNodeFileSystem();
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem,
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});
		const manager = createCodingPluginsManager({
			workspace,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
			verifyManagedInstallation: (record, options) => services.installationStore.verify(record, options),
		});
		const staleInventory = await manager.refresh({ enablement: {}, managedInstallations: [] });
		expect(staleInventory.plugins[0]).toMatchObject({
			installationId: "direct-tools@workspace-local",
			enabled: true,
		});
		let dirtyCount = 0;
		const deactivate = services.activateProjectRefresh(
			async () => Promise.reject(new Error("runtime publication unavailable")),
			() => ({
				plugins: staleInventory,
				agentPluginServerIds: Object.freeze([]),
				mcp: { revision: 1, servers: [], tools: [], diagnostics: [] },
			}),
			workspace,
			() => dirtyCount++,
		);
		const stdout = new BufferOutput();

		try {
			await expect(
				services.dispatch(
					{
						command: "disable",
						pluginId: "direct-tools@workspace-local",
						pluginName: "direct-tools",
						marketplaceName: "workspace-local",
						json: true,
					},
					{ stdout },
				),
			).resolves.toBe(1);
			const failure = JSON.parse(stdout.take());
			expect(failure).toMatchObject({
				schemaVersion: 1,
				type: "plugin_error",
				code: "plugin_change_notification_failed",
				operation: "disable",
				pluginId: "direct-tools@workspace-local",
				committed: true,
				revision: expect.stringMatching(/^plugins:/u),
			});
			expect(settings.plugins).toEqual({ "direct-tools@workspace-local": { enabled: false } });
			expect(dirtyCount).toBe(2);
			const committed = await services.command.snapshot();
			expect(committed.revision).toBe(failure.revision);
			expect(committed.plugins).toEqual([
				expect.objectContaining({
					pluginId: "direct-tools@workspace-local",
					state: "disabled",
					enabled: false,
				}),
			]);
		} finally {
			deactivate();
		}
		const refreshed = await services.command.snapshot();
		expect(refreshed.plugins).toEqual([
			expect.objectContaining({ pluginId: "direct-tools@workspace-local", state: "disabled", enabled: false }),
		]);
	});

	it("keeps direct inspect, diagnostics, and enablement on the last canonical identity after invalidation", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-direct-invalidated-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		const pluginRoot = join(workspace, ".agents", "plugins", "opaque-slot");
		await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(homeDirectory)]);
		const manifestPath = join(pluginRoot, "plugin.json");
		await writeFile(
			manifestPath,
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "canonical-tools", version: "1.0.0" }),
		);
		let settings: UserSettings = {
			plugins: { "canonical-tools@workspace-local": { enabled: false } },
		};
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:canonical-invalid` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});

		expect((await services.command.snapshot()).plugins).toEqual([
			expect.objectContaining({ pluginId: "canonical-tools@workspace-local", state: "disabled" }),
		]);
		await writeFile(manifestPath, JSON.stringify({ name: "canonical-tools" }));

		const invalid = await services.command.snapshot();
		expect(invalid.plugins).toEqual([
			expect.objectContaining({
				pluginId: "canonical-tools@workspace-local",
				state: "invalid",
				enabled: false,
			}),
		]);
		expect(invalid.diagnostics).toContainEqual(
			expect.objectContaining({ pluginId: "canonical-tools@workspace-local" }),
		);
	});

	it("trusts enabled and changed Workspace Plugin MCP hashes before the same Project refresh barrier", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-session-trust-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		const pluginRoot = join(workspace, ".agents", "plugins", "workspace-tools");
		await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(homeDirectory)]);
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "workspace-tools" }),
		);
		const mcpPath = join(pluginRoot, "mcp.json");
		const writeMcp = (url: string) =>
			writeFile(
				mcpPath,
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: { docs: { type: "streamable-http", url } },
				}),
			);
		await writeMcp("https://first.example.test/mcp");
		let settings: UserSettings = {
			plugins: { "workspace-tools@workspace-local": { enabled: false } },
		};
		const save = vi.fn(async (next: UserSettings) => {
			settings = next;
		});
		const settingsStore = {
			load: async () => settings,
			update: async (mutator: (current: UserSettings) => UserSettings) => {
				settings = mutator(settings);
				return settings;
			},
			save,
		};
		const fileSystem = createNodeFileSystem();
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem,
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:session-trust` },
			settings: settingsStore,
		});
		const manager = createCodingPluginsManager({
			workspace,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
		});
		let inventory = await manager.refresh({ enablement: settings.plugins ?? {} });
		let active: ApplicationPluginActiveCatalog = {
			plugins: inventory,
			agentPluginServerIds: Object.freeze([] as string[]),
			mcp: { revision: 1, servers: Object.freeze([]), tools: Object.freeze([]), diagnostics: Object.freeze([]) },
		};
		const review = vi.fn(async () => true);
		const committed = vi.fn(async () => undefined);
		let refreshes = 0;
		const deactivate = services.activateProjectRefresh(
			async () => {
				refreshes++;
				const trustedAtBarrier = settings.workspaceMcpTrust ?? [];
				inventory = await manager.refresh({ enablement: settings.plugins ?? {} });
				const sources = inventory.mcpSources.filter((source) =>
					trustedAtBarrier.some(
						(record) =>
							record.workspace === workspace && record.path === source.path && record.sha256 === source.sha256,
					),
				);
				const serverIds = sources.flatMap(({ servers }) => servers.map(({ id }) => id));
				active = {
					plugins: inventory,
					agentPluginServerIds: Object.freeze(serverIds),
					mcp: {
						revision: refreshes + 1,
						servers: Object.freeze(
							sources.flatMap((source) =>
								source.servers.map((server) =>
									Object.freeze({
										id: server.id,
										semanticName: `${source.plugin.snapshot.manifest.name}:${server.name}`,
										status: "ready" as const,
										toolCount: 1,
									}),
								),
							),
						),
						tools: Object.freeze([]),
						diagnostics: Object.freeze([]),
					},
				};
			},
			() => active,
			workspace,
			undefined,
			{ onCommitted: committed },
		);

		try {
			const enabled = await services.command.enable("workspace-tools@workspace-local", review);
			expect(enabled.plugins[0]).toMatchObject({ enabled: true, trust: "trusted", health: "ready" });
			expect(review).toHaveBeenCalledOnce();
			expect(review).toHaveBeenLastCalledWith({
				workspace,
				pluginId: "workspace-tools@workspace-local",
				path: await realpath(mcpPath),
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
			});
			expect(committed).toHaveBeenCalledOnce();
			const firstTrust = settings.workspaceMcpTrust?.[0];
			expect(firstTrust).toMatchObject({
				workspace,
				path: await realpath(mcpPath),
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
			});

			await writeMcp("https://second.example.test/mcp");
			const changed = await services.command.refresh(review);
			expect(changed.plugins[0]).toMatchObject({ trust: "trusted", health: "ready" });
			expect(review).toHaveBeenCalledTimes(2);
			expect(committed).toHaveBeenCalledTimes(2);
			expect(settings.workspaceMcpTrust).toHaveLength(1);
			expect(settings.workspaceMcpTrust?.[0]?.sha256).not.toBe(firstTrust?.sha256);
			expect(refreshes).toBe(2);
			expect(save).not.toHaveBeenCalled();
		} finally {
			deactivate();
		}
	});

	it.each([
		["disable", false],
		["enable", true],
	] as const)(
		"reports a direct %s commit when effective projection fails and retries dirty notification best-effort",
		async (operation, enabled) => {
			const root = await mkdtemp(join(tmpdir(), "coda-plugin-direct-projection-"));
			temporary.push(root);
			const workspace = join(root, "workspace");
			const homeDirectory = join(root, "home");
			const pluginRoot = join(workspace, ".agents", "plugins", "direct-tools");
			await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(homeDirectory)]);
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "direct-tools", version: "1.0.0" }),
			);
			let settings: UserSettings = enabled
				? { plugins: { "direct-tools@workspace-local": { enabled: false } } }
				: {};
			let projectionUnavailable = false;
			let id = 0;
			const services = createApplicationPluginServices({
				homeDirectory,
				cwd: workspace,
				environment: {},
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				settings: {
					load: async () => {
						if (projectionUnavailable) throw new Error("effective direct projection unavailable");
						return settings;
					},
					save: async (next) => {
						settings = next;
					},
				},
			});
			let dirtyCount = 0;
			let refreshCount = 0;
			const deactivate = services.activateProjectRefresh(
				async () => {
					refreshCount++;
					projectionUnavailable = true;
				},
				undefined,
				workspace,
				() => dirtyCount++,
			);
			const stdout = new BufferOutput();

			try {
				await expect(
					services.dispatch(
						{
							command: operation,
							pluginId: "direct-tools@workspace-local",
							pluginName: "direct-tools",
							marketplaceName: "workspace-local",
							json: true,
						},
						{ stdout },
					),
				).resolves.toBe(1);
				expect(JSON.parse(stdout.take())).toMatchObject({
					type: "plugin_error",
					code: "plugin_post_commit_failed",
					operation,
					pluginId: "direct-tools@workspace-local",
					committed: true,
					revision: expect.stringMatching(/^plugins:/u),
				});
				expect(settings.plugins).toEqual({ "direct-tools@workspace-local": { enabled } });
				expect(dirtyCount).toBeGreaterThanOrEqual(2);
				expect(refreshCount).toBeGreaterThanOrEqual(2);
			} finally {
				projectionUnavailable = false;
				deactivate();
			}
			await expect(services.command.snapshot()).resolves.toMatchObject({
				plugins: [
					expect.objectContaining({
						pluginId: "direct-tools@workspace-local",
						state: enabled ? "enabled" : "disabled",
					}),
				],
			});
		},
	);

	it("keeps an installed HTTP Plugin valid while projecting a 401 MCP startup failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-http-health-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
		const marketplace = await writeMarketplace(join(root, "marketplace"));
		await writeFile(
			join(marketplace, ".agents", "plugins", "packages", "review-tools", "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { docs: { type: "streamable-http", url: "https://docs.example.test/mcp" } },
			}),
		);
		let settings: UserSettings = {};
		let id = 0;
		const fileSystem = createNodeFileSystem();
		const services = createApplicationPluginServices({
			homeDirectory,
			cwd: workspace,
			environment: {},
			fileSystem,
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
		});
		await services.management.marketplaceAdd({ source: "local", root: marketplace });
		await services.management.install("review-tools@team-market");
		const manager = createCodingPluginsManager({
			workspace,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
			verifyManagedInstallation: (record, options) => services.installationStore.verify(record, options),
		});
		const inventory = await manager.refresh({
			enablement: settings.plugins ?? {},
			managedInstallations: (await services.installationStore.list()).installations,
		});
		const serverId = inventory.mcpSources[0]!.servers[0]!.id;
		const deactivate = services.activateProjectRefresh(
			async () => undefined,
			() => ({
				plugins: inventory,
				agentPluginServerIds: Object.freeze([serverId]),
				mcp: {
					revision: 1,
					servers: [
						{
							id: serverId,
							semanticName: "review-tools:docs",
							status: "degraded",
							toolCount: 0,
							error: "HTTP 401 Unauthorized",
						},
					],
					tools: [],
					diagnostics: [
						{
							serverId,
							serverSemanticName: "review-tools:docs",
							code: "mcp-connect-failed",
							message: "HTTP 401 Unauthorized",
						},
					],
				},
			}),
			workspace,
		);

		try {
			const snapshot = await services.command.snapshot();
			expect(snapshot.plugins[0]).toMatchObject({
				pluginId: "review-tools@team-market",
				state: "enabled",
				validity: "valid",
				health: "failed-to-start",
			});
			expect(snapshot.diagnostics).toContainEqual(
				expect.objectContaining({
					pluginId: "review-tools@team-market",
					code: "mcp-connect-failed",
					componentName: "review-tools:docs",
					message: "HTTP 401 Unauthorized",
				}),
			);
		} finally {
			deactivate();
		}
	});

	it.each(["ready", "degraded"] as const)(
		"projects Plugin MCP materialization failures in %s native same-id state without stealing native provenance",
		async (status) => {
			const root = await mkdtemp(join(tmpdir(), "coda-plugin-native-id-collision-"));
			temporary.push(root);
			const workspace = join(root, "workspace");
			const homeDirectory = join(root, "home");
			await Promise.all([mkdir(workspace), mkdir(homeDirectory)]);
			const marketplace = await writeMarketplace(join(root, "marketplace"));
			await writeFile(
				join(marketplace, ".agents", "plugins", "packages", "review-tools", "mcp.json"),
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: { docs: { type: "streamable-http", url: "https://docs.example.test/mcp" } },
				}),
			);
			let settings: UserSettings = {};
			let id = 0;
			const fileSystem = createNodeFileSystem();
			const services = createApplicationPluginServices({
				homeDirectory,
				cwd: workspace,
				environment: {},
				fileSystem,
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				settings: {
					load: async () => settings,
					save: async (next) => {
						settings = next;
					},
				},
			});
			await services.management.marketplaceAdd({ source: "local", root: marketplace });
			await services.management.install("review-tools@team-market");
			const manager = createCodingPluginsManager({
				workspace,
				userHome: homeDirectory,
				dataRoot: join(homeDirectory, ".coda", "plugin-data"),
				fileSystem,
				verifyManagedInstallation: (record, options) => services.installationStore.verify(record, options),
			});
			const inventory = await manager.refresh({
				enablement: settings.plugins ?? {},
				managedInstallations: (await services.installationStore.list()).installations,
			});
			const collidingServerId = inventory.mcpSources[0]!.servers[0]!.id;
			const plugin = inventory.plugins[0]!;
			const deactivate = services.activateProjectRefresh(
				async () => undefined,
				() => ({
					plugins: inventory,
					agentPluginServerIds: Object.freeze([]),
					pluginMcpDiagnostics: Object.freeze([
						{
							code: "mcp-server-materialization-failed",
							severity: "warning" as const,
							phase: "mcp" as const,
							message: 'Could not materialize MCP Server "docs": command does not exist',
							componentName: "docs",
							pluginRoot: plugin.snapshot.root,
							origin: plugin.origin,
						},
						{
							code: "plugin-mcp-server-id-collision",
							severity: "warning" as const,
							phase: "mcp" as const,
							message: `Skipped Plugin MCP Server "docs" because id "${collidingServerId}" is already in use`,
							pluginRoot: plugin.snapshot.root,
							origin: plugin.origin,
							serverId: collidingServerId,
							serverName: "docs",
						},
						{
							code: "stale-plugin-mcp-diagnostic",
							severity: "warning" as const,
							phase: "mcp" as const,
							message: "A different installation must not inherit this failure",
							componentName: "docs",
							pluginRoot: plugin.snapshot.root,
							origin: {
								...plugin.origin,
								installationId: "review-tools@other-market",
							},
						},
					]),
					mcp: {
						revision: 1,
						servers: [
							{
								id: collidingServerId,
								semanticName: "native-docs",
								status,
								toolCount: status === "ready" ? 1 : 0,
								...(status === "degraded" ? { error: "native startup failed" } : {}),
							},
						],
						tools: [],
						diagnostics:
							status === "degraded"
								? [
										{
											serverId: collidingServerId,
											serverSemanticName: "native-docs",
											code: "mcp-connect-failed",
											message: "native startup failed",
										},
									]
								: [],
					},
				}),
				workspace,
			);

			try {
				const snapshot = await services.command.snapshot();
				expect(snapshot.plugins[0]).toMatchObject({
					pluginId: "review-tools@team-market",
					health: "failed-to-start",
				});
				expect(snapshot.diagnostics).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							pluginId: "review-tools@team-market",
							code: "mcp-server-materialization-failed",
							componentName: "review-tools:docs",
						}),
						expect.objectContaining({
							pluginId: "review-tools@team-market",
							code: "plugin-mcp-server-id-collision",
							componentName: "review-tools:docs",
						}),
					]),
				);
				expect(snapshot.diagnostics).not.toContainEqual(
					expect.objectContaining({
						pluginId: "review-tools@team-market",
						componentName: "native-docs",
					}),
				);
				expect(snapshot.diagnostics).not.toContainEqual(
					expect.objectContaining({ code: "stale-plugin-mcp-diagnostic" }),
				);
			} finally {
				deactivate();
			}
		},
	);

	it.each(["creation", "owner-write", "owner-execute"] as const)(
		"skips Plugin stdio when PLUGIN_DATA %s validation fails while retaining its HTTP sibling",
		async (failure) => {
			const base = createNodeFileSystem();
			const connectionKinds: string[] = [];
			const isPluginData = (path: string): boolean => path.includes(`${sep}.coda${sep}plugin-data${sep}`);
			const value = await applicationFixture({
				fileSystem: {
					...base,
					makeDirectory: async (path, options) => {
						if (failure === "creation" && isPluginData(path)) {
							throw new Error("Plugin data mkdir unavailable");
						}
						await base.makeDirectory(path, options);
					},
					lstat: async (path) => {
						const status = await base.lstat(path);
						if (failure === "creation" || !isPluginData(path) || status.kind !== "directory") return status;
						return {
							...status,
							mode: status.mode & ~(failure === "owner-write" ? 0o200 : 0o100),
						};
					},
				},
				mcpConnector: {
					connect: async (server) => {
						connectionKinds.push(server.transport.kind);
						return {
							info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
							listTools: async () => [{ name: "inspect", inputSchema: { type: "object", properties: {} } }],
							callTool: async () => ({ isError: false, content: [] }),
							close: async () => undefined,
						};
					},
				},
			});
			const pluginRoot = join(value.homeDirectory, ".agents", "plugins", "mixed-tools");
			await mkdir(pluginRoot, { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mixed-tools" }),
			);
			await writeFile(
				join(pluginRoot, "mcp.json"),
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: {
						local: { type: "stdio", command: "must-not-start" },
						remote: { type: "streamable-http", url: "https://docs.example.test/mcp" },
					},
				}),
			);
			const faux = fauxProvider({ runtime: testTimeRuntime(15) });
			faux.setResponses([fauxAssistantMessage("HTTP sibling retained", { timestamp: 15 })]);
			value.models.setProvider(faux.provider);

			await expect(
				value.application.run([
					"--print",
					"--model",
					`${faux.getModel().provider}/${faux.getModel().id}`,
					"inspect safely",
				]),
			).resolves.toBe(0);

			expect(value.stdout.take()).toBe("HTTP sibling retained\n");
			expect(connectionKinds).toEqual(["http"]);
			expect(value.stderr.value).toContain("Plugin data");
		},
	);

	it("does not follow a prepositioned Plugin data symlink and retains the HTTP sibling", async () => {
		const outside = await mkdtemp(join(tmpdir(), "coda-plugin-data-outside-"));
		temporary.push(outside);
		await chmod(outside, 0o755);
		const base = createNodeFileSystem();
		const connectionKinds: string[] = [];
		let plantedPath: string | undefined;
		const pluginDataLeaf = `${sep}.coda${sep}plugin-data${sep}`;
		const value = await applicationFixture({
			fileSystem: {
				...base,
				makeDirectory: async (path, options) => {
					if (!plantedPath && path.includes(pluginDataLeaf)) {
						await base.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
						await symlink(outside, path);
						plantedPath = path;
					}
					await base.makeDirectory(path, options);
				},
			},
			mcpConnector: {
				connect: async (server) => {
					connectionKinds.push(server.transport.kind);
					return {
						info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
						listTools: async () => [{ name: "inspect", inputSchema: { type: "object", properties: {} } }],
						callTool: async () => ({ isError: false, content: [] }),
						close: async () => undefined,
					};
				},
			},
		});
		const pluginRoot = join(value.homeDirectory, ".agents", "plugins", "mixed-tools");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mixed-tools" }),
		);
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					local: { type: "stdio", command: "must-not-start" },
					remote: { type: "streamable-http", url: "https://docs.example.test/mcp" },
				},
			}),
		);
		const faux = fauxProvider({ runtime: testTimeRuntime(16) });
		faux.setResponses([fauxAssistantMessage("HTTP sibling retained", { timestamp: 16 })]);
		value.models.setProvider(faux.provider);

		await expect(
			value.application.run([
				"--print",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"inspect safely",
			]),
		).resolves.toBe(0);

		expect(plantedPath).toBeDefined();
		expect(connectionKinds).toEqual(["http"]);
		expect((await stat(outside)).mode & 0o777).toBe(0o755);
		expect(value.stderr.value).toContain("Plugin data");
	});

	it.each(["new", "existing"] as const)(
		"never chmods a %s Plugin data leaf whose pathname could be swapped to an external symlink",
		async (dataState) => {
			const outside = await mkdtemp(join(tmpdir(), "coda-plugin-data-chmod-outside-"));
			temporary.push(outside);
			await chmod(outside, 0o755);
			const base = createNodeFileSystem();
			const connectionKinds: string[] = [];
			let pluginDataLeaf: string | undefined;
			let leafSetModes = 0;
			const pluginDataLeafSegment = `${sep}.coda${sep}plugin-data${sep}`;
			const value = await applicationFixture({
				fileSystem: {
					...base,
					makeDirectory: async (path, options) => {
						await base.makeDirectory(path, options);
						if (path.includes(pluginDataLeafSegment)) pluginDataLeaf = path;
					},
					setMode: async (path, mode) => {
						if (path === pluginDataLeaf) {
							leafSetModes++;
							await rename(path, `${path}-displaced`);
							await symlink(outside, path);
						}
						await base.setMode(path, mode);
					},
				},
				mcpConnector: {
					connect: async (server) => {
						connectionKinds.push(server.transport.kind);
						return {
							info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
							listTools: async () => [{ name: "inspect", inputSchema: { type: "object", properties: {} } }],
							callTool: async () => ({ isError: false, content: [] }),
							close: async () => undefined,
						};
					},
				},
			});
			const pluginRoot = join(value.homeDirectory, ".agents", "plugins", "mixed-tools");
			await mkdir(pluginRoot, { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mixed-tools" }),
			);
			await writeFile(
				join(pluginRoot, "mcp.json"),
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: {
						local: { type: "stdio", command: "must-not-start" },
						remote: { type: "streamable-http", url: "https://docs.example.test/mcp" },
					},
				}),
			);
			if (dataState === "existing") {
				const inventory = await createCodingPluginsManager({
					workspace: value.workspace,
					userHome: value.homeDirectory,
					dataRoot: join(value.homeDirectory, ".coda", "plugin-data"),
					fileSystem: base,
				}).refresh();
				const existingLeaf = inventory.plugins[0]?.dataDirectory;
				if (!existingLeaf) throw new Error("expected a Plugin data directory");
				await mkdir(existingLeaf, { recursive: true, mode: 0o700 });
				await chmod(existingLeaf, 0o755);
				pluginDataLeaf = await base.realpath(existingLeaf);
			}
			const faux = fauxProvider({ runtime: testTimeRuntime(17) });
			faux.setResponses([fauxAssistantMessage("Plugin data ready", { timestamp: 17 })]);
			value.models.setProvider(faux.provider);

			await expect(
				value.application.run([
					"--print",
					"--model",
					`${faux.getModel().provider}/${faux.getModel().id}`,
					"inspect safely",
				]),
			).resolves.toBe(0);

			expect(pluginDataLeaf).toBeDefined();
			expect(leafSetModes).toBe(0);
			expect(connectionKinds).toEqual(["stdio", "http"]);
			expect((await stat(outside)).mode & 0o777).toBe(0o755);
		},
	);

	it.each(["coda-parent", "plugin-data-root"] as const)(
		"rejects a symlinked client Plugin data ancestor (%s) before creating an instance directory",
		async (attack) => {
			const outside = await mkdtemp(join(tmpdir(), "coda-plugin-data-root-outside-"));
			temporary.push(outside);
			await chmod(outside, 0o755);
			const connectionKinds: string[] = [];
			const value = await applicationFixture({
				mcpConnector: {
					connect: async (server) => {
						connectionKinds.push(server.transport.kind);
						return {
							info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
							listTools: async () => [{ name: "inspect", inputSchema: { type: "object", properties: {} } }],
							callTool: async () => ({ isError: false, content: [] }),
							close: async () => undefined,
						};
					},
				},
			});
			if (attack === "coda-parent") {
				await symlink(outside, join(value.homeDirectory, ".coda"));
			} else {
				await mkdir(join(value.homeDirectory, ".coda"), { recursive: true });
				await symlink(outside, join(value.homeDirectory, ".coda", "plugin-data"));
			}
			const pluginRoot = join(value.homeDirectory, ".agents", "plugins", "mixed-tools");
			await mkdir(pluginRoot, { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mixed-tools" }),
			);
			await writeFile(
				join(pluginRoot, "mcp.json"),
				JSON.stringify({
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: {
						local: { type: "stdio", command: "must-not-start" },
						remote: { type: "streamable-http", url: "https://docs.example.test/mcp" },
					},
				}),
			);
			const faux = fauxProvider({ runtime: testTimeRuntime(17) });
			faux.setResponses([fauxAssistantMessage("HTTP sibling retained", { timestamp: 17 })]);
			value.models.setProvider(faux.provider);

			await expect(
				value.application.run([
					"--print",
					"--model",
					`${faux.getModel().provider}/${faux.getModel().id}`,
					"inspect safely",
				]),
			).resolves.toBe(0);

			expect(connectionKinds).toEqual(["http"]);
			expect(await readdir(outside)).toEqual([]);
			expect((await stat(outside)).mode & 0o777).toBe(0o755);
			expect(value.stderr.value).toContain(attack === "coda-parent" ? "Coda data directory" : "Plugin dataRoot");
		},
	);

	it("projects and enables direct Workspace Agent Plugins through the same management surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-direct-management-"));
		temporary.push(root);
		const workspace = join(root, "workspace");
		const homeDirectory = join(root, "home");
		const pluginRoot = join(workspace, ".agents", "plugins", "direct-tools");
		const invalidPluginRoot = join(workspace, ".agents", "plugins", "broken-tools");
		await Promise.all([
			mkdir(join(pluginRoot, "skills", "inspect"), { recursive: true }),
			mkdir(invalidPluginRoot, { recursive: true }),
			mkdir(homeDirectory),
		]);
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "direct-tools",
				version: "2.0.0",
				description: "Direct workspace tools",
			}),
		);
		await writeFile(
			join(pluginRoot, "skills", "inspect", "SKILL.md"),
			"---\nname: inspect\ndescription: Inspect directly\n---\n\nInspect directly.\n",
		);
		await mkdir(join(pluginRoot, "skills", "inspect", "assets"), { recursive: true });
		const directAsset = join(pluginRoot, "skills", "inspect", "assets", "template.txt");
		await writeFile(directAsset, "first template\n");
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					Docs: { type: "streamable-http", url: "https://upper-docs.example.test/mcp" },
					docs: { type: "streamable-http", url: "https://lower-docs.example.test/mcp" },
				},
			}),
		);
		await writeFile(join(invalidPluginRoot, "plugin.json"), JSON.stringify({ name: "broken-tools" }));
		let settings: UserSettings = {};
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models: createModels({ runtime: testTimeRuntime() }),
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
			runtime: {
				homeDirectory,
				cwd: workspace,
				platform: "darwin",
				environment: {},
				clock: { now: () => 0 },
				idGenerator: { generate: (kind) => `${kind}:direct` },
			},
		});

		await expect(application.run(["plugin", "list", "--available", "--json"])).resolves.toBe(0);
		const initial = JSON.parse(stdout.take());
		expect(initial.installed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pluginId: "direct-tools@workspace-local",
					state: "enabled",
					scope: "workspace",
					contributions: {
						skills: ["direct-tools:inspect"],
						mcpServers: ["direct-tools:Docs", "direct-tools:docs"],
					},
					trust: "untrusted",
					health: "disconnected",
				}),
				expect.objectContaining({ pluginId: "broken-tools@workspace-local", state: "invalid", invalid: true }),
			]),
		);
		expect(initial.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ pluginId: "broken-tools@workspace-local" })]),
		);
		await expect(application.run(["plugin", "inspect", "direct-tools@workspace-local", "--json"])).resolves.toBe(0);
		const firstInspection = JSON.parse(stdout.take());
		expect(firstInspection).toMatchObject({
			type: "plugin_inspect",
			plugin: {
				pluginId: "direct-tools@workspace-local",
				scope: "workspace",
				selectedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				selectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
				trust: "untrusted",
				health: "disconnected",
			},
		});
		expect(firstInspection.plugin.selectedRevision).toBe(firstInspection.plugin.selectedDigest);
		await writeFile(directAsset, "second template\n");
		await expect(application.run(["plugin", "inspect", "direct-tools@workspace-local", "--json"])).resolves.toBe(0);
		const changedInspection = JSON.parse(stdout.take());
		expect(changedInspection.plugin.selectedDigest).not.toBe(firstInspection.plugin.selectedDigest);
		expect(changedInspection.plugin.selectedRevision).toBe(changedInspection.plugin.selectedDigest);
		await expect(application.run(["plugin", "disable", "direct-tools@workspace-local", "--json"])).resolves.toBe(0);
		expect(JSON.parse(stdout.take()).plugin).toMatchObject({ state: "installed", enabled: false });
		expect(settings.plugins).toEqual({ "direct-tools@workspace-local": { enabled: false } });
		await expect(application.run(["plugin", "enable", "direct-tools@workspace-local", "--json"])).resolves.toBe(0);
		expect(JSON.parse(stdout.take()).plugin).toMatchObject({ state: "enabled", enabled: true });
		await expect(application.run(["plugin", "remove", "direct-tools@workspace-local", "--json"])).resolves.toBe(1);
		expect(JSON.parse(stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_operation_failed",
			operation: "remove",
			pluginId: "direct-tools@workspace-local",
			committed: false,
			message: "Direct Plugin installations cannot be removed; remove its package directory explicitly",
		});
		expect(stderr.value).toBe("");
	});

	it("binds interactive /plugins inventory to --workspace instead of the startup directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-plugin-workspace-binding-"));
		temporary.push(root);
		const startupWorkspace = join(root, "startup");
		const selectedWorkspace = join(root, "selected");
		const homeDirectory = join(root, "home");
		const startupPlugin = join(startupWorkspace, ".agents", "plugins", "startup-tools");
		const selectedPlugin = join(selectedWorkspace, ".agents", "plugins", "selected-tools");
		await Promise.all([
			mkdir(startupPlugin, { recursive: true }),
			mkdir(selectedPlugin, { recursive: true }),
			mkdir(homeDirectory),
		]);
		await Promise.all([
			writeFile(
				join(startupPlugin, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "startup-tools" }),
			),
			writeFile(
				join(selectedPlugin, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "selected-tools" }),
			),
		]);
		const runtime = testTimeRuntime(20);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const getAuth = vi.spyOn(models, "getAuth");
		const terminal = new VirtualTerminal({ columns: 100, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let settings: UserSettings = {
			defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
		};
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => settings,
				save: async (next) => {
					settings = next;
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: startupWorkspace,
				homeDirectory,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:workspace-binding` },
				scheduler: createSystemScheduler(),
			},
		});

		await expect(application.run(["--workspace", selectedWorkspace, "plugin", "list", "--json"])).resolves.toBe(0);
		expect(JSON.parse(stdout.take()).installed).toEqual([
			expect.objectContaining({ pluginId: "selected-tools@workspace-local", state: "enabled" }),
		]);
		await expect(
			application.run([
				"--workspace",
				selectedWorkspace,
				"plugin",
				"inspect",
				"selected-tools@workspace-local",
				"--json",
			]),
		).resolves.toBe(0);
		expect(JSON.parse(stdout.take())).toMatchObject({
			type: "plugin_inspect",
			plugin: { pluginId: "selected-tools@workspace-local", scope: "workspace" },
		});
		await expect(
			application.run([
				"--workspace",
				selectedWorkspace,
				"plugin",
				"disable",
				"selected-tools@workspace-local",
				"--json",
			]),
		).resolves.toBe(0);
		expect(JSON.parse(stdout.take()).plugin).toMatchObject({
			pluginId: "selected-tools@workspace-local",
			state: "installed",
			enabled: false,
		});
		await expect(
			application.run([
				"--workspace",
				selectedWorkspace,
				"plugin",
				"enable",
				"selected-tools@workspace-local",
				"--json",
			]),
		).resolves.toBe(0);
		expect(JSON.parse(stdout.take()).plugin).toMatchObject({
			pluginId: "selected-tools@workspace-local",
			state: "enabled",
			enabled: true,
		});
		expect(getAuth).not.toHaveBeenCalled();
		expect(stderr.value).toBe("");
		const running = application.run([
			"--interactive",
			"--no-color",
			"--no-session",
			"--workspace",
			selectedWorkspace,
		]);

		try {
			await until(() => terminal.started && terminal.readOutput().includes(`${faux.getModel().provider}/`));
			terminal.clearOutput();
			await terminal.emit({ type: "text", text: "/plugins" });
			await terminal.emit({
				type: "key",
				key: "enter",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			await until(() => {
				const output = terminal.readOutput();
				return output.includes("startup-tools") || output.includes("selected-tools");
			});
			expect(terminal.readOutput()).toContain("selected-tools");
			expect(terminal.readOutput()).not.toContain("startup-tools");
		} finally {
			await terminal.emit({
				type: "key",
				key: "escape",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			for (let count = 0; count < 2; count++) {
				await terminal.emit({
					type: "key",
					key: "c",
					text: "c",
					shift: false,
					control: true,
					alt: false,
					meta: false,
					action: "press",
				});
			}
		}
		await expect(running).resolves.toBe(0);
	});
});
