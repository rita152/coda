import type { McpHostSnapshot, McpToolDescriptor } from "@coda/mcp";
import { isTriggerCompatibleName } from "./mentions.ts";
import type { CommandRegistry } from "./registry.ts";
import { type CommandExtensionEntry, registerCommandExtension } from "./unified-registry.ts";

const SERVER_COMMAND_PREFIX = "scope:server:";
export const MCP_SERVER_COMMAND_PREFIX = `mcp:${SERVER_COMMAND_PREFIX}`;

export function mcpToolIdFromCommandId(commandId: string): string | undefined {
	return commandId.startsWith("mcp:") && !commandId.startsWith(MCP_SERVER_COMMAND_PREFIX) ? commandId : undefined;
}

export function mcpServerIdFromCommandId(commandId: string): string | undefined {
	if (!commandId.startsWith(MCP_SERVER_COMMAND_PREFIX)) return undefined;
	return decodeURIComponent(commandId.slice(MCP_SERVER_COMMAND_PREFIX.length));
}

export function mcpToolsForCommandId(
	commandId: string,
	tools: readonly McpToolDescriptor[],
): readonly McpToolDescriptor[] {
	const serverId = mcpServerIdFromCommandId(commandId);
	if (serverId !== undefined) {
		return Object.freeze(tools.filter((tool) => tool.serverId === serverId));
	}
	const toolId = mcpToolIdFromCommandId(commandId);
	return Object.freeze(toolId ? tools.filter((tool) => tool.id === toolId) : []);
}

/** Projects ready MCP Tools into `$` Composer entries as immutable presence assertions. */
export function mcpExtensionEntries(snapshot: McpHostSnapshot): readonly CommandExtensionEntry[] {
	const used = new Set<string>();
	const entries: CommandExtensionEntry[] = [];
	const servers = new Map(snapshot.servers.map((server) => [server.id, server]));
	const serverIds = [...new Set(snapshot.tools.map((tool) => tool.serverId))].sort();
	for (const serverId of serverIds) {
		const semanticName = servers.get(serverId)?.semanticName ?? serverId;
		if (!isTriggerCompatibleName(semanticName) || used.has(semanticName)) continue;
		used.add(semanticName);
		entries.push(
			Object.freeze({
				id: `${SERVER_COMMAND_PREFIX}${encodeURIComponent(serverId)}`,
				name: semanticName,
				title: `${semanticName} MCP Server`,
				description: `Reference every Tool from MCP Server ${semanticName} and require it to remain available for this Run`,
			}),
		);
	}
	const tools = [...snapshot.tools].sort(
		(left, right) =>
			left.serverId.localeCompare(right.serverId) ||
			left.remoteName.localeCompare(right.remoteName) ||
			left.id.localeCompare(right.id),
	);
	for (const tool of tools) {
		const name = [tool.remoteName, `${tool.serverSemanticName}-${tool.remoteName}`, tool.name].find(
			(candidate) => isTriggerCompatibleName(candidate) && !used.has(candidate),
		);
		if (!name) continue;
		used.add(name);
		entries.push(
			Object.freeze({
				id: tool.id.replace(/^mcp:/u, ""),
				name,
				title: tool.title ?? tool.remoteName,
				description: tool.description,
			}),
		);
	}
	return Object.freeze(entries);
}

export class McpCommandRegistryBinding {
	readonly #registry: CommandRegistry;
	#dispose: readonly (() => void)[] = [];

	constructor(registry: CommandRegistry) {
		this.#registry = registry;
	}

	sync(snapshot: McpHostSnapshot): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
		const next: (() => void)[] = [];
		try {
			for (const entry of mcpExtensionEntries(snapshot)) {
				next.push(registerCommandExtension(this.#registry, "mcp", entry));
			}
			this.#dispose = Object.freeze(next);
		} catch (error) {
			for (const dispose of next.reverse()) dispose();
			throw error;
		}
	}

	dispose(): void {
		for (const dispose of this.#dispose) dispose();
		this.#dispose = [];
	}
}
