import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_SCHEMA, createPlugins } from "../src/index.ts";
import { nodePluginFileSystem } from "./helpers.ts";

const temporaryDirectories: string[] = [];
const PLUGIN_ROOT_PLACEHOLDER = "${" + "PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${" + "PLUGIN_DATA}";
const UNKNOWN_PLACEHOLDER = "${" + "UNKNOWN}";

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugins-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeSkill(root: string, directory: string, name: string): Promise<void> {
	const target = join(root, "skills", directory);
	await mkdir(target, { recursive: true });
	await writeFile(
		join(target, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} plugin skill\n---\n\nUse ${name}.\n`,
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Agent Plugin loader", () => {
	it("loads a minimal root manifest into an immutable snapshot", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "minimal" }));

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({
			root,
			origin: { source: "test" },
		});

		expect(snapshot).toMatchObject({
			status: "loaded",
			requestedRoot: root,
			root: await realpath(root),
			manifest: { $schema: AGENT_PLUGIN_SCHEMA, name: "minimal" },
			diagnostics: [],
		});
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates).toEqual([]);
		expect(snapshot.mcpServers).toEqual([]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.manifest)).toBe(true);
		expect(Object.isFrozen(snapshot.mcpServers)).toBe(true);
	});

	it("retains typed manifest metadata while reporting and ignoring the two non-fatal schema exceptions", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "acme.tools",
				version: "release-candidate",
				description: "Portable tools",
				author: { name: "A", email: "not-an-email", url: "not-a-url" },
				homepage: "not-a-url",
				repository: "local",
				license: "not-spdx",
				keywords: ["portable", "agent"],
				extensions: false,
				skills: "must-not-redirect-discovery",
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({
			root,
			origin: "test",
		});

		expect(snapshot).toMatchObject({
			status: "loaded",
			manifest: {
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "acme.tools",
				version: "release-candidate",
				description: "Portable tools",
				author: { name: "A", email: "not-an-email", url: "not-a-url" },
				homepage: "not-a-url",
				repository: "local",
				license: "not-spdx",
				keywords: ["portable", "agent"],
			},
			diagnostics: [
				{ code: "manifest-extensions-ignored", field: "extensions", severity: "warning" },
				{ code: "manifest-unknown-field", field: "skills", severity: "warning" },
			],
		});
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(Object.isFrozen(snapshot.manifest.author)).toBe(true);
		expect(Object.isFrozen(snapshot.manifest.keywords)).toBe(true);
	});

	it.each([
		[{ name: "Uppercase" }, "name"],
		[{ name: "has--double" }, "name"],
		[{ name: "valid", version: 1 }, "version"],
		[{ name: "valid", author: { handle: "extra" } }, "author"],
		[{ name: "valid", keywords: ["ok", 1] }, "keywords"],
	])("rejects fatal manifest schema violations before component discovery (%s)", async (fields, field) => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, ...fields }));
		await writeFile(join(root, "mcp.json"), "not json");

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({
			status: "rejected",
			diagnostics: [{ code: "plugin-manifest-invalid", severity: "error", phase: "manifest" }],
		});
		expect(snapshot.diagnostics[0]?.message).toContain(field);
		expect("skills" in snapshot).toBe(false);
	});

	it("delegates only immediate fixed-location Skills to the strict Agent Skills loader", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		await writeSkill(root, "review", "review");
		await writeSkill(root, "group/nested", "nested");
		await mkdir(join(root, "skills", "lower"));
		await writeFile(join(root, "skills", "lower", "skill.md"), "not discovered");

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({
			root,
			origin: { scope: "workspace" },
		});

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["review"]);
		expect(snapshot.skills.candidates[0]?.provenance[0]?.origin).toEqual({ scope: "workspace" });
		const activation = await snapshot.skills.activate(snapshot.skills.candidates[0]!.id);
		expect(activation).toMatchObject({ ok: true, activation: { body: "\nUse review.\n" } });
	});

	it("isolates an invalid strict Skill and reports the delegated diagnostic", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		await writeSkill(root, "valid", "valid");
		await writeSkill(root, "mismatch", "different");

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["valid"]);
		expect(snapshot.skills.diagnostics).toContainEqual(
			expect.objectContaining({ code: "name-directory-mismatch", severity: "error" }),
		);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({ code: "name-directory-mismatch", phase: "skill", severity: "error" }),
		);
	});

	it("loads valid MCP entries independently and skips unsupported HTTP+SSE", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mcp" }));
		const mcp = JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Tenant": "public" } },
				local: { type: "stdio", command: "node", args: ["server.mjs"] },
				legacy: { type: "sse", url: "https://example.test/sse" },
				broken: { type: "stdio", command: "node", surprise: true },
			},
		});
		await writeFile(join(root, "mcp.json"), mcp);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["local", "remote"]);
		expect(snapshot.mcpServers[0]).toMatchObject({
			pluginName: "mcp",
			configuration: { type: "stdio", command: "node", args: ["server.mjs"] },
		});
		expect(snapshot.mcpServers[1]).toMatchObject({
			configuration: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		expect(snapshot.mcpConfiguration).toEqual({
			path: join(await realpath(root), "mcp.json"),
			sha256: createHash("sha256").update(mcp).digest("hex"),
		});
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "mcp-server-invalid", phase: "mcp", severity: "warning" }),
				expect.objectContaining({
					code: "mcp-transport-unsupported",
					phase: "mcp",
					severity: "info",
				}),
			]),
		);
		expect(Object.isFrozen(snapshot.mcpServers[0]?.configuration)).toBe(true);
	});

	it("enforces portable Streamable HTTP URL and literal-header rules per server", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "http" }));
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					insecure: { type: "streamable-http", url: "http://example.test/mcp" },
					localhost: { type: "streamable-http", url: "http://localhost:3000/mcp" },
					loopback: { type: "streamable-http", url: "http://127.0.0.2/mcp" },
					duplicate: {
						type: "streamable-http",
						url: "https://example.test/mcp",
						headers: { "X-Tenant": "one", "x-tenant": "two" },
					},
					invalidHeader: {
						type: "streamable-http",
						url: "https://example.test/mcp",
						headers: { "X-Bad\nName": "value" },
					},
				},
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["localhost", "loopback"]);
		expect(snapshot.diagnostics.filter(({ code }) => code === "mcp-server-invalid")).toHaveLength(3);
	});

	it("materializes stdio launch values with single-pass placeholders and forced reserved environment", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, PLUGIN_DATA_PLACEHOLDER);
		const dataDirectory = join(await temporaryDirectory(), "data");
		await mkdir(join(root, "bin"), { recursive: true });
		await mkdir(dataDirectory);
		await writeFile(join(root, "bin", "server"), "#!/bin/sh\n");
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "stdio" }));
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					local: {
						type: "stdio",
						command: "./bin/server",
						args: [
							PLUGIN_ROOT_PLACEHOLDER,
							`${PLUGIN_DATA_PLACEHOLDER}/state`,
							UNKNOWN_PLACEHOLDER,
							`${PLUGIN_ROOT_PLACEHOLDER}/../opaque`,
						],
						env: {
							PATH: "plugin-path",
							ROOT: PLUGIN_ROOT_PLACEHOLDER,
							DATA: `prefix:${PLUGIN_DATA_PLACEHOLDER}`,
							LITERAL: "$HOME",
						},
						cwd: PLUGIN_DATA_PLACEHOLDER,
					},
				},
			}),
		);
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
			dataDirectory,
			baseEnvironment: { HOME: "/home/test", PATH: "base-path", OMITTED: undefined, PLUGIN_ROOT: "spoofed" },
			platform: "linux",
		});

		expect(materialized.diagnostics).toEqual([]);
		expect(materialized.servers).toHaveLength(1);
		const server = materialized.servers[0]!;
		expect(server.transport).toEqual({
			kind: "stdio",
			command: await realpath(join(root, "bin", "server")),
			args: [
				await realpath(root),
				`${await realpath(dataDirectory)}/state`,
				UNKNOWN_PLACEHOLDER,
				`${await realpath(root)}/../opaque`,
			],
			cwd: await realpath(dataDirectory),
			environment: {
				HOME: "/home/test",
				PATH: "plugin-path",
				ROOT: await realpath(root),
				DATA: `prefix:${await realpath(dataDirectory)}`,
				LITERAL: "$HOME",
				PLUGIN_ROOT: await realpath(root),
				PLUGIN_DATA: await realpath(dataDirectory),
			},
		});
		expect((server.transport.kind === "stdio" && server.transport.args?.[0]) || "").toContain(
			PLUGIN_DATA_PLACEHOLDER,
		);
		expect(Object.isFrozen(server.transport)).toBe(true);
		expect(Object.isFrozen(materialized.servers)).toBe(true);
	});

	it("distinguishes absent fixed locations from present broken symlinks", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "broken" }));
		await symlink(join(root, "missing-skills"), join(root, "skills"));
		await symlink(join(root, "missing-mcp.json"), join(root, "mcp.json"));

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "skills-component-invalid", phase: "skill" }),
				expect.objectContaining({ code: "mcp-component-invalid", phase: "mcp" }),
			]),
		);
	});

	it("distinguishes an absent immediate SKILL.md from a present broken symlink", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		await mkdir(join(root, "skills", "absent"), { recursive: true });
		await mkdir(join(root, "skills", "broken"));
		await writeSkill(root, "valid", "valid");
		await symlink(join(root, "missing-SKILL.md"), join(root, "skills", "broken", "SKILL.md"));

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["valid"]);
		expect(snapshot.diagnostics.filter(({ code }) => code === "plugin-skill-invalid")).toEqual([
			expect.objectContaining({
				phase: "skill",
				path: join(root, "skills", "broken", "SKILL.md"),
				severity: "warning",
			}),
		]);
	});
});
