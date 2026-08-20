import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlugins } from "@coda/plugins";
import { describe, expect, it } from "vitest";
import type { FileSystem } from "../../src/host/file-system.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { loadCodingPluginMarketplace } from "../../src/plugins/marketplace.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/agent-plugins", import.meta.url));

function fixture(name: string): string {
	return join(FIXTURES, name);
}

function rejectForeignProtocolAccess(base: FileSystem, probes: string[]): FileSystem {
	const observe = (path: string): void => {
		if (!path.split(sep).includes(".codex-plugin")) return;
		probes.push(path);
		throw new Error(`foreign package path was probed: ${path}`);
	};
	return {
		...base,
		realpath: async (path) => {
			observe(path);
			return base.realpath(path);
		},
		stat: async (path) => {
			observe(path);
			return base.stat(path);
		},
		lstat: async (path) => {
			observe(path);
			return base.lstat(path);
		},
		readFile: async (path) => {
			observe(path);
			return base.readFile(path);
		},
		readDirectory: async (path) => {
			observe(path);
			return base.readDirectory(path);
		},
	};
}

describe("checked-in Agent Plugins conformance corpus", () => {
	it("loads Skill-only, MCP-only, and combined Agent Plugins from their fixed locations", async () => {
		const loader = createPlugins({ fileSystem: createNodeFileSystem() });
		const [skillOnly, mcpOnly, combined] = await Promise.all([
			loader.load({ root: fixture("skill-only"), origin: { fixture: "skill-only" } }),
			loader.load({ root: fixture("mcp-only"), origin: { fixture: "mcp-only" } }),
			loader.load({ root: fixture("combined"), origin: { fixture: "combined" } }),
		]);

		expect(skillOnly.status).toBe("loaded");
		expect(mcpOnly.status).toBe("loaded");
		expect(combined.status).toBe("loaded");
		if (skillOnly.status !== "loaded" || mcpOnly.status !== "loaded" || combined.status !== "loaded") {
			throw new Error("expected valid fixture packages to load");
		}
		expect(skillOnly.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["review"]);
		expect(skillOnly.mcpServers).toEqual([]);
		expect(mcpOnly.skills.candidates).toEqual([]);
		expect(mcpOnly.mcpServers.map(({ name }) => name)).toEqual(["read-only"]);
		expect(combined.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["inspect"]);
		expect(combined.mcpServers.map(({ name }) => name)).toEqual(["fixture-server"]);
	});

	it("keeps duplicate manifest identity explicit for the client selection layer", async () => {
		const loader = createPlugins({ fileSystem: createNodeFileSystem() });
		const [first, second] = await Promise.all([
			loader.load({ root: fixture("duplicate-a"), origin: "duplicate-a" }),
			loader.load({ root: fixture("duplicate-b"), origin: "duplicate-b" }),
		]);
		if (first.status !== "loaded" || second.status !== "loaded") {
			throw new Error("expected duplicate fixtures to be individually valid");
		}
		expect(first.manifest).toMatchObject({ name: "fixture-duplicate", version: "1.0.0" });
		expect(second.manifest).toMatchObject({ name: "fixture-duplicate", version: "2.0.0" });
	});

	it("rejects malformed, escaping, and foreign packages without compatibility probing", async () => {
		const base = createNodeFileSystem();
		const probes: string[] = [];
		const guarded = rejectForeignProtocolAccess(base, probes);
		const loader = createPlugins({ fileSystem: guarded });

		const malformed = await loader.load({ root: fixture("malformed"), origin: "malformed" });
		const foreign = await loader.load({ root: fixture("foreign-only"), origin: "foreign" });
		const malicious = await loadCodingPluginMarketplace({
			root: fixture("malicious-source"),
			fileSystem: guarded,
		});

		expect(malformed.status).toBe("rejected");
		expect(foreign.status).toBe("rejected");
		expect(probes).toEqual([]);
		expect(malicious.status).toBe("loaded");
		expect(malicious.entries).toEqual([]);
		expect(malicious.diagnostics).toEqual([
			expect.objectContaining({ code: "plugin-marketplace-entry-invalid", severity: "warning" }),
		]);
	});
});
