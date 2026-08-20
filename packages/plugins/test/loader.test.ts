import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, createPlugins, DEFAULT_PLUGIN_LIMITS } from "../src/index.ts";
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

	it("preserves portable metadata strings exactly because the protocol constrains only their JSON types", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "normalized",
				version: "  1.2.3  ",
				description: " \n\t ",
				author: { name: " \t ", email: "  ", url: "author-relative" },
				homepage: "  https://example.test/plugin  ",
				keywords: ["", "  portable  "],
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({
			status: "loaded",
			manifest: {
				name: "normalized",
				version: "  1.2.3  ",
				description: " \n\t ",
				author: { name: " \t ", email: "  ", url: "author-relative" },
				homepage: "  https://example.test/plugin  ",
				keywords: ["", "  portable  "],
			},
		});
	});

	it("retains blank optional metadata strings as valid schema values", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "blank-metadata",
				version: " \n ",
				description: "\t",
				author: { name: "  " },
				homepage: " \r\n ",
				keywords: ["", "  "],
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.manifest).toEqual({
			$schema: AGENT_PLUGIN_SCHEMA,
			name: "blank-metadata",
			version: " \n ",
			description: "\t",
			author: { name: "  " },
			homepage: " \r\n ",
			keywords: ["", "  "],
		});
	});

	it("ignores unimplemented extension namespaces without validating their member values", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "opaque-extensions",
				extensions: {
					"com.example.object": { enabled: true },
					"com.example.scalar": "owned by another client",
				},
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({ status: "loaded", diagnostics: [] });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.manifest).not.toHaveProperty("extensions");
	});

	it.each([
		[{ name: "Uppercase" }, "name"],
		[{ name: "has--double" }, "name"],
		[{ name: "valid", version: 1 }, "version"],
		[{ name: "valid", version: null }, "version"],
		[{ name: "valid", description: 1 }, "description"],
		[{ name: "valid", description: null }, "description"],
		[{ name: "valid", author: null }, "author"],
		[{ name: "valid", author: { name: 1 } }, "name"],
		[{ name: "valid", author: { name: null } }, "name"],
		[{ name: "valid", homepage: 1 }, "homepage"],
		[{ name: "valid", homepage: null }, "homepage"],
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

	it.each([
		[{ author: null, extensions: false, future: true }, ["extensions", "future"]],
		[{ version: 1, extensions: false, futureA: true, futureB: true }, ["extensions", "futureA", "futureB"]],
	])("reports every non-fatal manifest exception even when another field is fatal (%s)", async (fields, warnings) => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "mixed-invalid", ...fields }),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		expect(snapshot.status).toBe("rejected");
		expect(snapshot.diagnostics.map(({ field }) => field).filter(Boolean)).toEqual(warnings);
		expect(snapshot.diagnostics.at(-1)).toMatchObject({
			code: "plugin-manifest-invalid",
			severity: "error",
		});
	});

	it("ignores an adjacent legacy .codex-plugin package without overlaying standard metadata or components", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "portable",
				version: "1.0.0",
				description: "Portable description",
			}),
		);
		await writeSkill(root, "portable-skill", "portable-skill");
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { portable: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);
		const legacyRoot = join(root, ".codex-plugin");
		await mkdir(join(legacyRoot, "skills", "legacy-skill"), { recursive: true });
		await writeFile(
			join(legacyRoot, "plugin.json"),
			JSON.stringify({
				name: "legacy-shadow",
				version: "9.9.9",
				description: "Must not overlay portable metadata",
				interface: { displayName: "Legacy display name" },
			}),
		);
		await writeFile(
			join(legacyRoot, "skills", "legacy-skill", "SKILL.md"),
			"---\nname: legacy-skill\ndescription: Must not load\n---\n",
		);
		await writeFile(join(legacyRoot, "mcp.json"), "not portable MCP JSON");

		const baseFileSystem = nodePluginFileSystem();
		let legacyAccesses = 0;
		const rejectLegacyAccess = (path: string): void => {
			if (!path.includes(`${sep}.codex-plugin${sep}`)) return;
			legacyAccesses++;
			throw new Error("nested legacy manifests must not be probed");
		};
		const snapshot = await createPlugins({
			fileSystem: {
				...baseFileSystem,
				realpath: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.realpath(path);
				},
				stat: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.stat(path);
				},
				lstat: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.lstat(path);
				},
				readFile: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.readFile(path);
				},
				readDirectory: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.readDirectory(path);
				},
			},
		}).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({
			status: "loaded",
			manifest: {
				name: "portable",
				version: "1.0.0",
				description: "Portable description",
			},
		});
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["portable-skill"]);
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["portable"]);
		expect(snapshot.diagnostics).toEqual([]);
		expect(legacyAccesses).toBe(0);
	});

	it.each([".codex-plugin", ".CODEX-PLUGIN"])(
		"rejects plugin.json resolving into reserved %s content before target probes",
		async (reservedName) => {
			const root = await temporaryDirectory();
			const reservedRoot = join(root, reservedName);
			await mkdir(reservedRoot);
			await writeFile(
				join(reservedRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
			);
			await symlink(join(reservedRoot, "plugin.json"), join(root, "plugin.json"), "file");
			const base = nodePluginFileSystem();
			let reservedProbes = 0;
			const forbidden = (path: string): boolean =>
				path.split(/[\\/]/u).some((component) => component.toLowerCase() === ".codex-plugin");
			const rejectReserved = (path: string): never => {
				reservedProbes++;
				throw new Error(`reserved manifest target was probed: ${path}`);
			};

			const snapshot = await createPlugins({
				fileSystem: {
					...base,
					realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
					stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
					readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
				},
			}).load({ root, origin: "test" });

			expect(snapshot.status).toBe("rejected");
			expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "plugin-manifest-invalid" }));
			expect(reservedProbes).toBe(0);
		},
	);

	it("isolates skills/ and mcp.json aliases into reserved content without probing their targets", async () => {
		const root = await temporaryDirectory();
		const reservedRoot = join(root, ".codex-plugin");
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable" }));
		await writeSkill(reservedRoot, "review", "review");
		await writeFile(
			join(reservedRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { forbidden: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);
		await symlink(join(reservedRoot, "skills"), join(root, "skills"), "dir");
		await symlink(join(reservedRoot, "mcp.json"), join(root, "mcp.json"), "file");
		const base = nodePluginFileSystem();
		let reservedProbes = 0;
		const forbidden = (path: string): boolean =>
			path.split(/[\\/]/u).some((component) => component.toLowerCase() === ".codex-plugin");
		const rejectReserved = (path: string): never => {
			reservedProbes++;
			throw new Error(`reserved component target was probed: ${path}`);
		};

		const snapshot = await createPlugins({
			fileSystem: {
				...base,
				realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
				stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
				lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
				readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
				readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
			},
		}).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded Plugin with isolated components");
		expect(snapshot.skills.candidates).toEqual([]);
		expect(snapshot.mcpServers).toEqual([]);
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "skills-component-invalid" }),
				expect.objectContaining({ code: "mcp-component-invalid" }),
			]),
		);
		expect(reservedProbes).toBe(0);
	});

	it("skips SKILL.md resolving into reserved content before probing the target", async () => {
		const root = await temporaryDirectory();
		const reservedRoot = join(root, ".codex-plugin");
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable" }));
		await mkdir(join(root, "skills", "review"), { recursive: true });
		await mkdir(reservedRoot);
		await writeFile(
			join(reservedRoot, "SKILL.md"),
			"---\nname: review\ndescription: Must not load\n---\n\nMust not load.\n",
		);
		await symlink(join(reservedRoot, "SKILL.md"), join(root, "skills", "review", "SKILL.md"), "file");
		const base = nodePluginFileSystem();
		let reservedProbes = 0;
		const forbidden = (path: string): boolean =>
			path.split(/[\\/]/u).some((component) => component.toLowerCase() === ".codex-plugin");
		const rejectReserved = (path: string): never => {
			reservedProbes++;
			throw new Error(`reserved Skill target was probed: ${path}`);
		};

		const snapshot = await createPlugins({
			fileSystem: {
				...base,
				realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
				stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
				lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
				readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
				readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
			},
		}).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded Plugin with an isolated Skill");
		expect(snapshot.skills.candidates).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "plugin-skill-invalid" }));
		expect(reservedProbes).toBe(0);
	});

	it("rejects a requested .codex-plugin root before reading its plugin.json", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, ".codex-plugin");
		await mkdir(root);
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
		);
		const baseFileSystem = nodePluginFileSystem();
		let fileReads = 0;

		const snapshot = await createPlugins({
			fileSystem: {
				...baseFileSystem,
				readFile: async () => {
					fileReads++;
					throw new Error("reserved Plugin roots must be rejected before reading files");
				},
			},
		}).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({
			status: "rejected",
			diagnostics: [
				{
					code: "plugin-root-unsupported",
					phase: "manifest",
					path: root,
					severity: "error",
				},
			],
		});
		expect(fileReads).toBe(0);
	});

	it.each([".codex-plugin", ".CODEX-PLUGIN"])(
		"rejects an ordinary alias whose canonical root is %s before probing the target",
		async (reservedName) => {
			const parent = await temporaryDirectory();
			const target = join(parent, reservedName);
			const root = join(parent, "portable-alias");
			await mkdir(target);
			await writeFile(
				join(target, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
			);
			await symlink(target, root);
			const baseFileSystem = nodePluginFileSystem();
			const canonicalTarget = await realpath(target);
			let reservedProbes = 0;
			const forbidden = (path: string): boolean =>
				path === canonicalTarget || path.startsWith(`${canonicalTarget}${sep}`);
			const rejectReserved = (path: string): never => {
				reservedProbes++;
				throw new Error(`reserved Plugin root was probed: ${path}`);
			};

			const snapshot = await createPlugins({
				fileSystem: {
					...baseFileSystem,
					realpath: async (path) => (forbidden(path) ? rejectReserved(path) : baseFileSystem.realpath(path)),
					stat: async (path) => (forbidden(path) ? rejectReserved(path) : baseFileSystem.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectReserved(path) : baseFileSystem.lstat(path)),
					readFile: async (path) => (forbidden(path) ? rejectReserved(path) : baseFileSystem.readFile(path)),
					readDirectory: async (path) =>
						forbidden(path) ? rejectReserved(path) : baseFileSystem.readDirectory(path),
				},
			}).load({ root, origin: "test" });

			expect(snapshot).toMatchObject({
				status: "rejected",
				requestedRoot: root,
				diagnostics: [
					{
						code: "plugin-root-unsupported",
						phase: "manifest",
						path: canonicalTarget,
						severity: "error",
					},
				],
			});
			expect(reservedProbes).toBe(0);
		},
	);

	it.each(["direct", "canonical-symlink"] as const)(
		"rejects a Plugin root nested anywhere below .codex-plugin before manifest reads: %s",
		async (kind) => {
			const parent = await temporaryDirectory();
			const target = join(parent, ".codex-plugin", "nested", "portable-looking");
			const root = kind === "direct" ? target : join(parent, "portable-alias");
			await mkdir(target, { recursive: true });
			await writeFile(
				join(target, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
			);
			if (kind === "canonical-symlink") await symlink(target, root);
			const baseFileSystem = nodePluginFileSystem();
			let fileReads = 0;

			const snapshot = await createPlugins({
				fileSystem: {
					...baseFileSystem,
					readFile: async () => {
						fileReads++;
						throw new Error("nested reserved Plugin roots must be rejected before reading files");
					},
				},
			}).load({ root, origin: "test" });

			expect(snapshot).toMatchObject({
				status: "rejected",
				diagnostics: [{ code: "plugin-root-unsupported", phase: "manifest", severity: "error" }],
			});
			expect(fileReads).toBe(0);
		},
	);

	it("pins manifest and component discovery to the canonical root when an alias is retargeted", async () => {
		const parent = await temporaryDirectory();
		const canonicalRoot = join(parent, "portable");
		const reservedRoot = join(parent, ".codex-plugin");
		const requestedRoot = join(parent, "portable-alias");
		await mkdir(canonicalRoot);
		await mkdir(reservedRoot);
		await writeFile(
			join(canonicalRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "canonical" }),
		);
		await writeSkill(canonicalRoot, "canonical-skill", "canonical-skill");
		await writeFile(
			join(canonicalRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { canonical: { type: "streamable-http", url: "https://example.test/canonical" } },
			}),
		);
		await writeFile(
			join(reservedRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
		);
		await writeSkill(reservedRoot, "must-not-load", "must-not-load");
		await writeFile(
			join(reservedRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { forbidden: { type: "streamable-http", url: "https://example.test/forbidden" } },
			}),
		);
		const expectedRoot = await realpath(canonicalRoot);
		const canonicalReservedRoot = await realpath(reservedRoot);
		await symlink(canonicalRoot, requestedRoot);

		const baseFileSystem = nodePluginFileSystem();
		const retargetedPaths: string[] = [];
		const canonicalReads: string[] = [];
		let retargeted = false;
		const rejectRetargetedPath = (path: string): void => {
			if (
				!path.startsWith(`${requestedRoot}${sep}`) &&
				!path.startsWith(`${reservedRoot}${sep}`) &&
				!path.startsWith(`${canonicalReservedRoot}${sep}`)
			) {
				return;
			}
			retargetedPaths.push(path);
			throw new Error("Plugin discovery must remain pinned to the canonical root");
		};

		const snapshot = await createPlugins({
			fileSystem: {
				...baseFileSystem,
				realpath: async (path) => {
					if (path !== requestedRoot) rejectRetargetedPath(path);
					const canonical = await baseFileSystem.realpath(path);
					if (path === requestedRoot && !retargeted) {
						await rm(requestedRoot);
						await symlink(reservedRoot, requestedRoot);
						retargeted = true;
					}
					return canonical;
				},
				stat: async (path) => {
					rejectRetargetedPath(path);
					return baseFileSystem.stat(path);
				},
				lstat: async (path) => {
					rejectRetargetedPath(path);
					return baseFileSystem.lstat(path);
				},
				readFile: async (path) => {
					rejectRetargetedPath(path);
					canonicalReads.push(path);
					return baseFileSystem.readFile(path);
				},
				readDirectory: async (path) => {
					rejectRetargetedPath(path);
					return baseFileSystem.readDirectory(path);
				},
			},
		}).load({ root: requestedRoot, origin: "test" });

		expect(retargeted).toBe(true);
		expect(snapshot).toMatchObject({
			status: "loaded",
			requestedRoot,
			root: expectedRoot,
			manifest: { name: "canonical" },
		});
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["canonical-skill"]);
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["canonical"]);
		expect(canonicalReads).toContain(join(expectedRoot, "plugin.json"));
		expect(canonicalReads.every((path) => path.startsWith(`${expectedRoot}${sep}`))).toBe(true);
		expect(retargetedPaths).toEqual([]);
	});

	it("rejects a legacy-only .codex-plugin package instead of treating it as an Agent Plugin", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".codex-plugin"));
		await writeFile(
			join(root, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name: "legacy-only", version: "1.0.0" }),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		expect(snapshot).toMatchObject({
			status: "rejected",
			diagnostics: [
				{
					code: "plugin-manifest-invalid",
					phase: "manifest",
					path: join(root, "plugin.json"),
					severity: "error",
				},
			],
		});
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

	it("keeps an internal SKILL.md symlink anchored to its logical Plugin Skill bundle", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		const logicalDirectory = join(await realpath(root), "skills", "demo");
		const sharedDirectory = join(await realpath(root), "shared");
		await mkdir(join(logicalDirectory, "assets"), { recursive: true });
		await mkdir(sharedDirectory);
		const source = "---\nname: demo\ndescription: Internal linked Skill\n---\n\nUse demo.\n";
		const sourceFile = join(sharedDirectory, "SKILL-source.md");
		await writeFile(sourceFile, source);
		await writeFile(join(sharedDirectory, "unrelated-secret.txt"), "must not become a Skill resource\n");
		await writeFile(join(logicalDirectory, "assets", "local.txt"), "logical resource\n");
		await symlink(sourceFile, join(logicalDirectory, "SKILL.md"), "file");

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates).toHaveLength(1);
		const candidate = snapshot.skills.candidates[0]!;
		expect(candidate.directory).toBe(logicalDirectory);
		expect(candidate.skillFile).toBe(join(logicalDirectory, "SKILL.md"));
		const activation = await snapshot.skills.activate(candidate.id);
		expect(activation).toMatchObject({
			ok: true,
			activation: {
				contents: source,
				baseDirectory: logicalDirectory,
				resources: ["assets/local.txt"],
			},
		});

		await writeFile(sourceFile, source.replace("Use demo.", "Use changed demo."));
		const stale = await snapshot.skills.activate(candidate.id);
		expect(stale).toMatchObject({ ok: false, diagnostic: { code: "snapshot-stale" } });
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

	it("identifies invalid sibling Skills structurally while leaving manifest diagnostics component-free", async () => {
		const root = await temporaryDirectory();
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills", ignored: true }),
		);
		await writeSkill(root, "alpha", "different-alpha");
		await writeSkill(root, "beta", "different-beta");

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.diagnostics.filter(({ code }) => code === "name-directory-mismatch")).toEqual([
			expect.objectContaining({ componentName: "alpha" }),
			expect.objectContaining({ componentName: "beta" }),
		]);
		expect(snapshot.diagnostics.find(({ code }) => code === "manifest-unknown-field")).not.toHaveProperty(
			"componentName",
		);
	});

	it("isolates each Plugin Skill discovery budget so a noisy sibling cannot hide later Skills", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		await writeSkill(root, "a-noisy", "a-noisy");
		await writeSkill(root, "z-valid", "z-valid");
		const baseFileSystem = nodePluginFileSystem();
		const noisyRoot = await realpath(join(root, "skills", "a-noisy"));
		const noisyEntries = Object.freeze(
			Array.from({ length: 20_001 }, (_, index) => ({ name: `resource-${index}`, kind: "directory" as const })),
		);

		const snapshot = await createPlugins({
			fileSystem: {
				...baseFileSystem,
				readDirectory: async (path) => (path === noisyRoot ? noisyEntries : baseFileSystem.readDirectory(path)),
			},
		}).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["z-valid"]);
		expect(snapshot.skills.diagnostics).toContainEqual(
			expect.objectContaining({ code: "scan-entry-limit-exceeded", severity: "error" }),
		);
	});

	it("enforces the package-wide default Skill component budget across immediate siblings", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		for (let index = 0; index < 1_001; index++) {
			const name = `skill-${String(index).padStart(4, "0")}`;
			await writeSkill(root, name, name);
		}

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(DEFAULT_PLUGIN_LIMITS.maxSkillComponents).toBe(1_000);
		expect(snapshot.skills.candidates).toHaveLength(DEFAULT_PLUGIN_LIMITS.maxSkillComponents);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-skill-component-limit-exceeded",
				phase: "skill",
				severity: "error",
			}),
		);
	});

	it("bounds the package-wide immediate Skill scan before per-component snapshots", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "skills" }));
		await writeSkill(root, "alpha", "alpha");
		await writeSkill(root, "beta", "beta");
		await writeSkill(root, "gamma", "gamma");

		const snapshot = await createPlugins({
			fileSystem: nodePluginFileSystem(),
			limits: { maxSkillScanEntries: 2 },
		}).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["alpha", "beta"]);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-skill-scan-limit-exceeded",
				phase: "skill",
				severity: "error",
			}),
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
					leadingSpace: { type: "streamable-http", url: " https://example.test/mcp" },
					authorityless: { type: "streamable-http", url: "https:example.test/mcp" },
					backslashAuthority: { type: "streamable-http", url: "https:\\example.test\\mcp" },
					emptyFragment: { type: "streamable-http", url: "https://example.test/mcp#" },
					emptyUserInfo: { type: "streamable-http", url: "https://@example.test/mcp" },
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
		expect(snapshot.diagnostics.filter(({ code }) => code === "mcp-server-invalid")).toHaveLength(8);
	});

	it("materializes stdio launch values with single-pass placeholders and forced reserved environment", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, PLUGIN_DATA_PLACEHOLDER);
		const dataRoot = await temporaryDirectory();
		const dataDirectory = join(dataRoot, "data");
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
			dataRoot: await realpath(dataRoot),
			dataDirectory: await realpath(dataDirectory),
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
