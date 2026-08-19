import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, createPlugins } from "../src/index.ts";
import { nodePluginFileSystem } from "./helpers.ts";

const temporaryDirectories: string[] = [];
const PLUGIN_ROOT_PLACEHOLDER = "${" + "PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${" + "PLUGIN_DATA}";
const PLUGIN_ROOTED_PLACEHOLDER = "${" + "PLUGIN_ROOTED}";

async function pluginRoot(name = "mcp"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "coda-plugins-mcp-"));
	temporaryDirectories.push(root);
	await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name }));
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Agent Plugin MCP configuration", () => {
	it.each([
		["invalid JSON", "{"],
		[
			"a mismatched schema",
			JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json", mcpServers: {} }),
		],
		[
			"an unknown top-level field",
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { otherwiseValid: { type: "stdio", command: "node" } },
				extra: true,
			}),
		],
		["a non-object server map", JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: [] })],
	])("isolates top-level MCP failure from valid Skills (%s)", async (_case, source) => {
		const root = await pluginRoot();
		await mkdir(join(root, "skills", "review"), { recursive: true });
		await writeFile(
			join(root, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review a change\n---\n\nReview it.\n",
		);
		await writeFile(join(root, "mcp.json"), source);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["review"]);
		expect(snapshot.mcpServers).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({ code: "mcp-configuration-invalid", phase: "mcp", severity: "warning" }),
		);
	});

	it("validates stdio command and cwd declared forms per entry", async () => {
		const root = await pluginRoot();
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					validBare: { type: "stdio", command: "node" },
					validRelative: { type: "stdio", command: "./bin/server", cwd: "./work" },
					validNormalizedRelative: {
						type: "stdio",
						command: "./bin/../server",
						cwd: "./work/../work",
					},
					validRepeatedSlash: {
						type: "stdio",
						command: ".//bin/server",
						cwd: `${PLUGIN_ROOT_PLACEHOLDER}//work`,
					},
					validRootCwd: {
						type: "stdio",
						command: "runner with spaces",
						cwd: `${PLUGIN_ROOT_PLACEHOLDER}/work`,
					},
					validDataCwd: { type: "stdio", command: "runner", cwd: PLUGIN_DATA_PLACEHOLDER },
					badAbsoluteCommand: { type: "stdio", command: "/usr/bin/runner" },
					badParentCommand: { type: "stdio", command: "../bin/runner" },
					badNestedBareCommand: { type: "stdio", command: "bin/runner" },
					badPlaceholderCommand: {
						type: "stdio",
						command: `${PLUGIN_ROOT_PLACEHOLDER}/bin/runner`,
					},
					badBackslashCommand: { type: "stdio", command: ".\\bin\\runner" },
					badRelativeEscapeCommand: { type: "stdio", command: "./../bin/runner" },
					badRelativeCwd: { type: "stdio", command: "runner", cwd: "work" },
					badAbsoluteCwd: { type: "stdio", command: "runner", cwd: "/tmp" },
					badRootPrefixCwd: {
						type: "stdio",
						command: "runner",
						cwd: `${PLUGIN_ROOTED_PLACEHOLDER}/work`,
					},
					badRelativeEscapeCwd: { type: "stdio", command: "runner", cwd: "./../outside" },
					badRootEscapeCwd: {
						type: "stdio",
						command: "runner",
						cwd: `${PLUGIN_ROOT_PLACEHOLDER}/../outside`,
					},
					badDataEscapeCwd: {
						type: "stdio",
						command: "runner",
						cwd: `${PLUGIN_DATA_PLACEHOLDER}/work/../../outside`,
					},
				},
			}),
		);

		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual([
			"badBackslashCommand",
			"badDataEscapeCwd",
			"badRelativeEscapeCommand",
			"badRelativeEscapeCwd",
			"badRootEscapeCwd",
			"validBare",
			"validDataCwd",
			"validNormalizedRelative",
			"validRelative",
			"validRepeatedSlash",
			"validRootCwd",
		]);
		expect(snapshot.diagnostics.filter(({ code }) => code === "mcp-server-invalid")).toHaveLength(7);
	});
});
