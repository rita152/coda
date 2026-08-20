import { type CodingPluginId, isCodingPluginLocalSource } from "../plugins/types.ts";

export interface PluginSelectionArguments {
	readonly pluginId: CodingPluginId;
	readonly pluginName: string;
	readonly marketplaceName: string;
}

export type PluginHelpTopic =
	| "plugin"
	| "plugin-add"
	| "plugin-inspect"
	| "plugin-enable"
	| "plugin-disable"
	| "plugin-upgrade"
	| "plugin-list"
	| "plugin-remove"
	| "plugin-marketplace"
	| "plugin-marketplace-add"
	| "plugin-marketplace-list"
	| "plugin-marketplace-upgrade"
	| "plugin-marketplace-remove";

export type PluginArgumentErrorCode =
	| "plugin-argument-required"
	| "plugin-argument-unexpected"
	| "plugin-command-required"
	| "plugin-command-unknown"
	| "plugin-option-conflict"
	| "plugin-option-unknown"
	| "plugin-option-value-required"
	| "plugin-selector-invalid"
	| "plugin-source-unsupported";

export class PluginArgumentError extends Error {
	readonly code: PluginArgumentErrorCode;
	readonly helpTopic: PluginHelpTopic;

	constructor(code: PluginArgumentErrorCode, message: string, helpTopic: PluginHelpTopic) {
		super(message);
		this.name = "PluginArgumentError";
		this.code = code;
		this.helpTopic = helpTopic;
	}
}

export type PluginCommandArguments =
	| (PluginSelectionArguments & {
			readonly command: "add" | "inspect" | "enable" | "disable" | "upgrade" | "remove";
			readonly json: boolean;
	  })
	| {
			readonly command: "list";
			readonly marketplaceName?: string;
			readonly json: boolean;
			readonly available: boolean;
	  }
	| {
			readonly command: "marketplace-add";
			readonly source: string;
			readonly ref?: string;
			readonly sparse: readonly string[];
			readonly json: boolean;
	  }
	| {
			readonly command: "marketplace-list";
			readonly json: boolean;
	  }
	| {
			readonly command: "marketplace-upgrade";
			readonly marketplaceName?: string;
			readonly json: boolean;
	  }
	| {
			readonly command: "marketplace-remove";
			readonly marketplaceName: string;
			readonly json: boolean;
	  }
	| {
			readonly command: "help";
			readonly topic: PluginHelpTopic;
	  };

export function parsePluginCommandArguments(args: readonly string[]): PluginCommandArguments {
	const helpTopic = requestedHelpTopic(args);
	if (helpTopic) return Object.freeze({ command: "help", topic: helpTopic });
	if (args[0] === "add") return parseSelectionCommand("add", args.slice(1));
	if (args[0] === "inspect") return parseSelectionCommand("inspect", args.slice(1));
	if (args[0] === "enable") return parseSelectionCommand("enable", args.slice(1));
	if (args[0] === "disable") return parseSelectionCommand("disable", args.slice(1));
	if (args[0] === "upgrade") return parseSelectionCommand("upgrade", args.slice(1));
	if (args[0] === "remove") return parseSelectionCommand("remove", args.slice(1));
	if (args[0] === "list") return parseListCommand(args.slice(1));
	if (args[0] === "marketplace") return parseMarketplaceCommand(args.slice(1));
	if (!args[0]) fail("plugin-command-required", "plugin requires a command", "plugin");
	fail("plugin-command-unknown", `unrecognized plugin command '${args[0]}'`, "plugin");
}

type PluginSelectionCommand = "add" | "inspect" | "enable" | "disable" | "upgrade" | "remove";
type PluginSelectionHelpTopic = `plugin-${PluginSelectionCommand}`;

function parseSelectionCommand(command: PluginSelectionCommand, args: readonly string[]): PluginCommandArguments {
	let json = false;
	let marketplaceName: string | undefined;
	let selector: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--marketplace" || argument === "-m" || argument.startsWith("--marketplace=")) {
			const inline = argument.startsWith("--marketplace=");
			marketplaceName = marketplaceOptionValue(argument, inline ? undefined : args[++index], `plugin-${command}`);
			continue;
		}
		if (argument.startsWith("-"))
			fail("plugin-option-unknown", `unknown plugin ${command} option: ${argument}`, `plugin-${command}`);
		if (selector !== undefined)
			fail("plugin-argument-unexpected", `unexpected plugin ${command} argument: ${argument}`, `plugin-${command}`);
		selector = argument;
	}
	if (!selector)
		fail("plugin-argument-required", `plugin ${command} requires <plugin>@<marketplace>`, `plugin-${command}`);
	const selection = parsePluginSelection(selector, marketplaceName, `plugin-${command}`);
	return Object.freeze({ command, ...selection, json });
}

function parseListCommand(args: readonly string[]): PluginCommandArguments {
	let json = false;
	let available = false;
	let marketplaceName: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--available") {
			available = true;
			continue;
		}
		if (argument === "--marketplace" || argument === "-m" || argument.startsWith("--marketplace=")) {
			const inline = argument.startsWith("--marketplace=");
			marketplaceName = marketplaceOptionValue(argument, inline ? undefined : args[++index], "plugin-list");
			continue;
		}
		if (argument.startsWith("-"))
			fail("plugin-option-unknown", `unknown plugin list option: ${argument}`, "plugin-list");
		fail("plugin-argument-unexpected", `unexpected plugin list argument: ${argument}`, "plugin-list");
	}
	if (available && !json) fail("plugin-option-conflict", "--available requires --json", "plugin-list");
	if (marketplaceName) assertMarketplaceName(marketplaceName, "plugin-list");
	return Object.freeze({ command: "list", ...(marketplaceName ? { marketplaceName } : {}), json, available });
}

function parseMarketplaceCommand(args: readonly string[]): PluginCommandArguments {
	const command = args[0];
	if (command === "add") return parseMarketplaceAdd(args.slice(1));
	if (command === "list") return parseMarketplaceList(args.slice(1));
	if (command === "upgrade") return parseMarketplaceUpgrade(args.slice(1));
	if (command === "remove") return parseMarketplaceRemove(args.slice(1));
	if (!command) fail("plugin-command-required", "plugin marketplace requires a command", "plugin-marketplace");
	fail("plugin-command-unknown", `unrecognized plugin marketplace command '${command}'`, "plugin-marketplace");
}

function parseMarketplaceAdd(args: readonly string[]): PluginCommandArguments {
	let source: string | undefined;
	let ref: string | undefined;
	let json = false;
	const sparse: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--ref" || argument.startsWith("--ref=")) {
			const inline = argument.startsWith("--ref=");
			const value = optionValue(argument, "--ref", inline ? undefined : args[++index]);
			ref = value;
			continue;
		}
		if (argument === "--sparse" || argument.startsWith("--sparse=")) {
			const inline = argument.startsWith("--sparse=");
			const value = optionValue(argument, "--sparse", inline ? undefined : args[++index]);
			sparse.push(value);
			continue;
		}
		if (argument.startsWith("-"))
			fail("plugin-option-unknown", `unknown plugin marketplace add option: ${argument}`, "plugin-marketplace-add");
		if (source !== undefined)
			fail(
				"plugin-argument-unexpected",
				`unexpected plugin marketplace add argument: ${argument}`,
				"plugin-marketplace-add",
			);
		source = argument;
	}
	if (!source) fail("plugin-argument-required", "plugin marketplace add requires <source>", "plugin-marketplace-add");
	if (/^npm(?::|:\/\/)/iu.test(source)) {
		fail(
			"plugin-source-unsupported",
			"Plugin Marketplace source must be a local path or Git source; npm sources are unsupported",
			"plugin-marketplace-add",
		);
	}
	return Object.freeze({
		command: "marketplace-add",
		source,
		...(ref ? { ref } : {}),
		sparse: Object.freeze([...sparse]),
		json,
	});
}

function parseMarketplaceList(args: readonly string[]): PluginCommandArguments {
	let json = false;
	for (const argument of args) {
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument.startsWith("-"))
			fail(
				"plugin-option-unknown",
				`unknown plugin marketplace list option: ${argument}`,
				"plugin-marketplace-list",
			);
		fail(
			"plugin-argument-unexpected",
			`unexpected plugin marketplace list argument: ${argument}`,
			"plugin-marketplace-list",
		);
	}
	return Object.freeze({ command: "marketplace-list", json });
}

function parseMarketplaceUpgrade(args: readonly string[]): PluginCommandArguments {
	const { json, positional } = parseJsonWithPositionals("upgrade", args);
	if (positional.length > 1)
		fail(
			"plugin-argument-unexpected",
			`unexpected plugin marketplace upgrade argument: ${positional[1]}`,
			"plugin-marketplace-upgrade",
		);
	const marketplaceName = positional[0];
	if (marketplaceName) assertConfigurableMarketplaceName(marketplaceName, "plugin-marketplace-upgrade");
	return Object.freeze({
		command: "marketplace-upgrade",
		...(marketplaceName ? { marketplaceName } : {}),
		json,
	});
}

function parseMarketplaceRemove(args: readonly string[]): PluginCommandArguments {
	const { json, positional } = parseJsonWithPositionals("remove", args);
	if (!positional[0])
		fail(
			"plugin-argument-required",
			"plugin marketplace remove requires <marketplace-name>",
			"plugin-marketplace-remove",
		);
	if (positional.length > 1)
		fail(
			"plugin-argument-unexpected",
			`unexpected plugin marketplace remove argument: ${positional[1]}`,
			"plugin-marketplace-remove",
		);
	assertConfigurableMarketplaceName(positional[0], "plugin-marketplace-remove");
	return Object.freeze({ command: "marketplace-remove", marketplaceName: positional[0], json });
}

function parseJsonWithPositionals(
	command: "remove" | "upgrade",
	args: readonly string[],
): { readonly json: boolean; readonly positional: readonly string[] } {
	let json = false;
	const positional: string[] = [];
	for (const argument of args) {
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument.startsWith("-"))
			fail(
				"plugin-option-unknown",
				`unknown plugin marketplace ${command} option: ${argument}`,
				`plugin-marketplace-${command}`,
			);
		positional.push(argument);
	}
	return { json, positional };
}

function optionValue(argument: string, option: "--ref" | "--sparse", following: string | undefined): string {
	const value = argument.startsWith(`${option}=`) ? argument.slice(option.length + 1) : following;
	if (!value || value.startsWith("-"))
		fail("plugin-option-value-required", `${option} requires a value`, "plugin-marketplace-add");
	return value;
}

function marketplaceOptionValue(
	argument: string,
	following: string | undefined,
	helpTopic: PluginSelectionHelpTopic | "plugin-list",
): string {
	const value = argument.startsWith("--marketplace=") ? argument.slice("--marketplace=".length) : following;
	if (!value || value.startsWith("-")) {
		fail("plugin-option-value-required", `${argument} requires a marketplace name`, helpTopic);
	}
	return value;
}

function parsePluginSelection(
	selector: string,
	selectedMarketplace: string | undefined,
	helpTopic: PluginSelectionHelpTopic,
): PluginSelectionArguments {
	const separator = selector.lastIndexOf("@");
	const hasQualifiedSelector = separator > 0 && separator < selector.length - 1;
	if (!hasQualifiedSelector && !selectedMarketplace) {
		fail(
			"plugin-selector-invalid",
			"plugin requires --marketplace unless passed as <plugin>@<marketplace>",
			helpTopic,
		);
	}
	const pluginName = hasQualifiedSelector ? selector.slice(0, separator) : selector;
	const embeddedMarketplace = hasQualifiedSelector ? selector.slice(separator + 1) : undefined;
	if (embeddedMarketplace && selectedMarketplace && embeddedMarketplace !== selectedMarketplace) {
		fail(
			"plugin-selector-invalid",
			`plugin id \`${selector}\` belongs to marketplace \`${embeddedMarketplace}\`, but --marketplace specified \`${selectedMarketplace}\``,
			helpTopic,
		);
	}
	const marketplaceName = embeddedMarketplace ?? selectedMarketplace!;
	assertPluginName(pluginName, helpTopic);
	assertMarketplaceName(marketplaceName, helpTopic);
	return Object.freeze({
		pluginId: `${pluginName}@${marketplaceName}` as CodingPluginId,
		pluginName,
		marketplaceName,
	});
}

function assertPluginName(value: string, helpTopic: PluginSelectionHelpTopic): void {
	if (value.length > 64 || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) {
		fail("plugin-selector-invalid", `invalid Plugin name: ${value}`, helpTopic);
	}
}

function assertMarketplaceName(value: string, helpTopic: PluginHelpTopic): void {
	if (!/^[A-Za-z0-9_-]+$/u.test(value))
		fail("plugin-selector-invalid", `invalid Plugin Marketplace name: ${value}`, helpTopic);
}

function assertConfigurableMarketplaceName(value: string, helpTopic: PluginHelpTopic): void {
	assertMarketplaceName(value, helpTopic);
	if (isCodingPluginLocalSource(value)) {
		fail(
			"plugin-selector-invalid",
			`Plugin Marketplace name \`${value}\` is reserved for direct Agent Plugin installations`,
			helpTopic,
		);
	}
}

function fail(code: PluginArgumentErrorCode, message: string, helpTopic: PluginHelpTopic): never {
	throw new PluginArgumentError(code, message, helpTopic);
}

function requestedHelpTopic(args: readonly string[]): PluginHelpTopic | undefined {
	if (args[0] === "help") return helpTopicForPath(args.slice(1));
	if (args[0] === "marketplace" && args[1] === "help") {
		return helpTopicForPath(["marketplace", ...args.slice(2)]);
	}
	const helpIndex = args.findIndex((argument) => argument === "--help" || argument === "-h");
	return helpIndex < 0 ? undefined : helpTopicForPath(args.slice(0, helpIndex));
}

function helpTopicForPath(path: readonly string[]): PluginHelpTopic {
	const key = path.join("/");
	const topic = HELP_TOPIC_BY_PATH[key];
	if (topic) return topic;
	const owner: PluginHelpTopic = path[0] === "marketplace" ? "plugin-marketplace" : "plugin";
	fail("plugin-command-unknown", `unrecognized plugin help topic '${path.join(" ")}'`, owner);
}

const HELP_TOPIC_BY_PATH: Readonly<Record<string, PluginHelpTopic>> = Object.freeze({
	"": "plugin",
	add: "plugin-add",
	inspect: "plugin-inspect",
	enable: "plugin-enable",
	disable: "plugin-disable",
	upgrade: "plugin-upgrade",
	list: "plugin-list",
	remove: "plugin-remove",
	marketplace: "plugin-marketplace",
	"marketplace/add": "plugin-marketplace-add",
	"marketplace/list": "plugin-marketplace-list",
	"marketplace/upgrade": "plugin-marketplace-upgrade",
	"marketplace/remove": "plugin-marketplace-remove",
});

const PLUGIN_HELP: Readonly<Record<PluginHelpTopic, string>> = Object.freeze({
	plugin: `Manage Coda plugins

Usage: coda plugin <COMMAND>

Commands:
  add          Install a Plugin from a configured Marketplace
  inspect      Show one Plugin and its contributions
  enable       Enable an installed Plugin for future Runs
  disable      Disable an installed Plugin for future Runs
  upgrade      Upgrade an installed Plugin
  list         List Plugins from configured Marketplaces
  marketplace  Add, list, upgrade, or remove Plugin Marketplaces
  remove       Remove an installed Plugin
  help         Show help for a Plugin command
`,
	"plugin-inspect": selectionCommandHelp("inspect", "Inspect a Plugin"),
	"plugin-enable": selectionCommandHelp("enable", "Enable an installed Plugin"),
	"plugin-disable": selectionCommandHelp("disable", "Disable an installed Plugin"),
	"plugin-upgrade": selectionCommandHelp("upgrade", "Upgrade an installed Plugin"),
	"plugin-add": `Install a Plugin from a configured Marketplace

Usage: coda plugin add [OPTIONS] <PLUGIN[@MARKETPLACE]>

Options:
  -m, --marketplace <MARKETPLACE>  Marketplace when the selector is unqualified
      --json                       Output install result as JSON
  -h, --help                       Show this help
`,
	"plugin-list": `List Plugins from configured Marketplaces

Usage: coda plugin list [OPTIONS]

Options:
  -m, --marketplace <MARKETPLACE>  Only list this Marketplace
      --json                       Output Plugin list as JSON
      --available                  Include uninstalled Plugins (requires --json)
  -h, --help                       Show this help
`,
	"plugin-remove": `Remove an installed Plugin

Usage: coda plugin remove [OPTIONS] <PLUGIN[@MARKETPLACE]>

Options:
  -m, --marketplace <MARKETPLACE>  Marketplace when the selector is unqualified
      --json                       Output remove result as JSON
  -h, --help                       Show this help
`,
	"plugin-marketplace": `Add, list, upgrade, or remove configured Plugin Marketplaces

Usage: coda plugin marketplace <COMMAND>

Commands:
  add      Add a local or Git Marketplace
  list     List configured Marketplaces
  upgrade  Refresh configured Git Marketplace snapshots
  remove   Remove a configured Marketplace
  help     Show help for a Marketplace command
`,
	"plugin-marketplace-add": `Add a local or Git marketplace to the configured marketplace sources

Usage: coda plugin marketplace add [OPTIONS] <SOURCE>

Arguments:
  <SOURCE>         Local path, owner/repo[@ref], HTTPS Git URL, or SSH Git URL

Options:
      --ref <REF>      Git ref to fetch
      --sparse <PATH>  Sparse checkout path (repeatable)
      --json           Output add result as JSON
  -h, --help           Show this help
`,
	"plugin-marketplace-list": `List configured Plugin Marketplaces

Usage: coda plugin marketplace list [OPTIONS]

Options:
      --json  Output Marketplace list as JSON
  -h, --help  Show this help
`,
	"plugin-marketplace-upgrade": `Refresh configured Git Marketplace snapshots

Usage: coda plugin marketplace upgrade [OPTIONS] [MARKETPLACE_NAME]

Options:
      --json  Output upgrade result as JSON
  -h, --help  Show this help
`,
	"plugin-marketplace-remove": `Remove a configured Plugin Marketplace

Usage: coda plugin marketplace remove [OPTIONS] <MARKETPLACE_NAME>

Options:
      --json  Output remove result as JSON
  -h, --help  Show this help
`,
});

export function pluginCommandHelp(topic: PluginHelpTopic): string {
	return PLUGIN_HELP[topic];
}

function selectionCommandHelp(command: PluginSelectionCommand, description: string): string {
	return `${description}

Usage: coda plugin ${command} [OPTIONS] <PLUGIN[@MARKETPLACE]>

Options:
  -m, --marketplace <MARKETPLACE>  Marketplace when the selector is unqualified
      --json                       Output operation result as JSON
  -h, --help                       Show this help
`;
}
