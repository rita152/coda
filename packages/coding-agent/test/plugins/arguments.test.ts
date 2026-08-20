import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/app/argument-parsing.ts";
import { PluginArgumentError, pluginCommandHelp } from "../../src/app/plugin-arguments.ts";

const io = {
	stdin: { isTTY: true, readAll: async () => "" },
	stdout: { isTTY: true, write: () => undefined },
	stderr: { isTTY: true, write: () => undefined },
};

describe("Plugin CLI arguments", () => {
	it("accepts the global Workspace selector before Plugin dispatch and rejects it inside the subcommand", async () => {
		await expect(parseArguments(["--workspace", "/selected", "plugin", "list", "--json"], io)).resolves.toMatchObject(
			{
				action: "plugin",
				workspace: "/selected",
				plugin: { command: "list", json: true },
			},
		);
		await expect(parseArguments(["plugin", "list", "--workspace", "/selected"], io)).rejects.toMatchObject({
			code: "plugin-option-unknown",
			helpTopic: "plugin-list",
		});
	});

	it("normalizes both install selector forms to one stable PluginId", async () => {
		await expect(parseArguments(["plugin", "add", "review-tools@team", "--json"], io)).resolves.toMatchObject({
			action: "plugin",
			plugin: {
				command: "add",
				pluginId: "review-tools@team",
				pluginName: "review-tools",
				marketplaceName: "team",
				json: true,
			},
		});
		await expect(parseArguments(["plugin", "add", "review-tools", "--marketplace=team"], io)).resolves.toMatchObject({
			action: "plugin",
			plugin: {
				command: "add",
				pluginId: "review-tools@team",
				pluginName: "review-tools",
				marketplaceName: "team",
				json: false,
			},
		});
	});

	it("parses filtered and available Plugin listings while enforcing Codex's JSON dependency", async () => {
		await expect(
			parseArguments(["plugin", "list", "--marketplace", "team", "--available", "--json"], io),
		).resolves.toMatchObject({
			action: "plugin",
			plugin: {
				command: "list",
				marketplaceName: "team",
				available: true,
				json: true,
			},
		});
		await expect(parseArguments(["plugin", "list", "--available"], io)).rejects.toThrow(
			"--available requires --json",
		);
		await expect(parseArguments(["plugin", "list", "--marketplace", "--json"], io)).rejects.toMatchObject({
			code: "plugin-option-value-required",
			helpTopic: "plugin-list",
		});
	});

	it("parses removal and preserves exact selector diagnostics", async () => {
		await expect(
			parseArguments(["plugin", "remove", "review-tools", "--marketplace", "team", "--json"], io),
		).resolves.toMatchObject({
			action: "plugin",
			plugin: {
				command: "remove",
				pluginId: "review-tools@team",
				pluginName: "review-tools",
				marketplaceName: "team",
				json: true,
			},
		});
		await expect(parseArguments(["plugin", "add", "review-tools"], io)).rejects.toThrow(
			"plugin requires --marketplace unless passed as <plugin>@<marketplace>",
		);
		await expect(parseArguments(["plugin", "remove", "review-tools@team", "-m", "other"], io)).rejects.toThrow(
			"plugin id `review-tools@team` belongs to marketplace `team`, but --marketplace specified `other`",
		);
	});

	it.each(["inspect", "enable", "disable", "upgrade"] as const)(
		"parses the extended %s lifecycle command with one stable PluginId",
		async (command) => {
			await expect(parseArguments(["plugin", command, "review-tools@team", "--json"], io)).resolves.toMatchObject({
				action: "plugin",
				plugin: {
					command,
					pluginId: "review-tools@team",
					pluginName: "review-tools",
					marketplaceName: "team",
					json: true,
				},
			});
		},
	);

	it("parses the local/Git-only Plugin Marketplace command family", async () => {
		await expect(
			parseArguments(
				[
					"plugin",
					"marketplace",
					"add",
					"owner/repo",
					"--ref",
					"main",
					"--sparse",
					"plugins/alpha",
					"--sparse=plugins/beta",
					"--json",
				],
				io,
			),
		).resolves.toMatchObject({
			action: "plugin",
			plugin: {
				command: "marketplace-add",
				source: "owner/repo",
				ref: "main",
				sparse: ["plugins/alpha", "plugins/beta"],
				json: true,
			},
		});
		await expect(parseArguments(["plugin", "marketplace", "list", "--json"], io)).resolves.toMatchObject({
			plugin: { command: "marketplace-list", json: true },
		});
		await expect(parseArguments(["plugin", "marketplace", "upgrade"], io)).resolves.toMatchObject({
			plugin: { command: "marketplace-upgrade", json: false },
		});
		await expect(parseArguments(["plugin", "marketplace", "upgrade", "team", "--json"], io)).resolves.toMatchObject({
			plugin: { command: "marketplace-upgrade", marketplaceName: "team", json: true },
		});
		await expect(parseArguments(["plugin", "marketplace", "remove", "team", "--json"], io)).resolves.toMatchObject({
			plugin: { command: "marketplace-remove", marketplaceName: "team", json: true },
		});
	});

	it.each(["workspace-local", "user-local"])(
		"reserves %s from Marketplace management while keeping direct Plugin selectors addressable",
		async (marketplace) => {
			await expect(
				parseArguments(["plugin", "inspect", `review-tools@${marketplace}`, "--json"], io),
			).resolves.toMatchObject({ plugin: { pluginId: `review-tools@${marketplace}` } });
			await expect(parseArguments(["plugin", "marketplace", "remove", marketplace], io)).rejects.toThrow(
				/reserved/u,
			);
			await expect(parseArguments(["plugin", "marketplace", "upgrade", marketplace], io)).rejects.toThrow(
				/reserved/u,
			);
		},
	);

	it("returns addressable Codex-style help and structured, narrow parse errors", async () => {
		await expect(parseArguments(["plugin", "marketplace", "add", "--help"], io)).resolves.toMatchObject({
			action: "plugin",
			plugin: { command: "help", topic: "plugin-marketplace-add" },
		});
		expect(
			pluginCommandHelp("plugin-marketplace-add"),
		).toBe(`Add a local or Git marketplace to the configured marketplace sources

Usage: coda plugin marketplace add [OPTIONS] <SOURCE>

Arguments:
  <SOURCE>         Local path, owner/repo[@ref], HTTPS Git URL, or SSH Git URL

Options:
      --ref <REF>      Git ref to fetch
      --sparse <PATH>  Sparse checkout path (repeatable)
      --json           Output add result as JSON
  -h, --help           Show this help
`);

		await expect(parseArguments(["plugin", "wat"], io)).rejects.toMatchObject({
			name: "PluginArgumentError",
			code: "plugin-command-unknown",
			helpTopic: "plugin",
			message: "unrecognized plugin command 'wat'",
		});
		await expect(parseArguments(["plugin", "marketplace", "add", "npm:old-plugin"], io)).rejects.toBeInstanceOf(
			PluginArgumentError,
		);
		await expect(parseArguments(["plugin", "install", "review-tools@team"], io)).rejects.toMatchObject({
			code: "plugin-command-unknown",
		});
	});
});
