import type { McpHostSnapshot, McpServerSnapshot } from "@coda/mcp";
import type { WorkspaceMcpConfigurationSnapshot } from "../mcp/config.ts";
import type { CommandFlowMenu, CommandFlowNavigation, CommandFlowOpener } from "./flow-types.ts";

export interface McpCommandSnapshot {
	readonly host: McpHostSnapshot;
	readonly workspace?: WorkspaceMcpConfigurationSnapshot;
}

export interface McpCommandFlowOptions {
	readonly snapshot: () => Promise<McpCommandSnapshot> | McpCommandSnapshot;
	readonly reload: () => Promise<McpCommandSnapshot>;
	readonly reconnect: (serverId: string) => Promise<McpCommandSnapshot>;
}

export async function openMcpCommand(
	flow: CommandFlowOpener,
	argument: string | undefined,
	options: McpCommandFlowOptions,
): Promise<void> {
	const [action, serverId, ...extra] = argument?.trim().split(/\s+/u).filter(Boolean) ?? [];
	if (extra.length > 0) throw new Error("Usage: /mcp [status|doctor|inspect|reload|reconnect] [server-id]");
	if (!action) {
		flow.open(await rootFlow(options));
		return;
	}
	switch (action) {
		case "status":
			if (serverId) throw new Error("Usage: /mcp status");
			flow.open(statusFlow(await options.snapshot()));
			return;
		case "doctor":
			if (serverId) throw new Error("Usage: /mcp doctor");
			flow.open(doctorFlow(await options.snapshot()));
			return;
		case "inspect": {
			const snapshot = await options.snapshot();
			flow.open(serverId ? inspectServerFlow(snapshot, serverId) : inspectFlow(snapshot));
			return;
		}
		case "reload":
			if (serverId) throw new Error("Usage: /mcp reload");
			flow.open(statusFlow(await options.reload()));
			return;
		case "reconnect":
			if (serverId) {
				flow.open(statusFlow(await options.reconnect(serverId)));
				return;
			}
			flow.open(reconnectFlow(await options.snapshot(), options));
			return;
		default:
			throw new Error(`Unknown /mcp action: ${action}`);
	}
}

async function rootFlow(options: McpCommandFlowOptions): Promise<CommandFlowMenu> {
	const snapshot = await options.snapshot();
	return {
		id: "mcp",
		title: "MCP",
		items: [
			{
				id: "status",
				label: "Status",
				description: "Show configured Server connection state",
				onSelect: (navigation) => navigation.push(statusFlow(snapshot)),
			},
			{
				id: "doctor",
				label: "Doctor",
				description: "Show trust, protocol, and Tool diagnostics",
				onSelect: (navigation) => navigation.push(doctorFlow(snapshot)),
			},
			{
				id: "inspect",
				label: "Inspect",
				description: "Inspect namespaced Tools by Server",
				onSelect: (navigation) => navigation.push(inspectFlow(snapshot)),
			},
			{
				id: "reload",
				label: "Reload",
				description: "Reload declarative User and Workspace configuration",
				onSelect: async (navigation) => navigation.push(statusFlow(await options.reload())),
			},
			{
				id: "reconnect",
				label: "Reconnect",
				description: "Explicitly reconnect one Server",
				onSelect: (navigation) => navigation.push(reconnectFlow(snapshot, options)),
			},
		],
	};
}

function serverDescription(server: McpServerSnapshot): string {
	const protocol = server.protocolVersion
		? `${server.protocolEra ?? "unknown"} ${server.protocolVersion}`
		: "not negotiated";
	return `${server.toolCount} Tool${server.toolCount === 1 ? "" : "s"} • ${protocol}${server.error ? ` • ${server.error}` : ""}`;
}

function statusFlow(snapshot: McpCommandSnapshot): CommandFlowMenu {
	return {
		id: "mcp-status",
		title: "MCP / Status",
		items:
			snapshot.host.servers.length > 0
				? snapshot.host.servers.map((server) => ({
						id: server.id,
						label: server.id,
						description: serverDescription(server),
						status: server.status,
					}))
				: [{ id: "empty", label: "No configured MCP Servers", disabledReason: "Add declarative configuration" }],
	};
}

function doctorFlow(snapshot: McpCommandSnapshot): CommandFlowMenu {
	const workspace = snapshot.workspace;
	const items = [
		...(workspace
			? [
					{
						id: "workspace-trust",
						label: "Workspace configuration",
						description: `${workspace.path} • SHA-256 ${workspace.sha256}`,
						status: workspace.trust,
					},
				]
			: []),
		...snapshot.host.diagnostics.map((diagnostic, index) => ({
			id: `diagnostic:${index}`,
			label: diagnostic.code,
			description: `${diagnostic.serverId}${diagnostic.toolName ? `/${diagnostic.toolName}` : ""}: ${diagnostic.message}`,
			status: "attention",
		})),
	];
	return {
		id: "mcp-doctor",
		title: "MCP / Doctor",
		items: items.length > 0 ? items : [{ id: "healthy", label: "No MCP diagnostics", status: "healthy" }],
	};
}

function inspectFlow(snapshot: McpCommandSnapshot): CommandFlowMenu {
	return {
		id: "mcp-inspect",
		title: "MCP / Inspect",
		filterable: true,
		items:
			snapshot.host.servers.length > 0
				? snapshot.host.servers.map((server) => ({
						id: server.id,
						label: server.id,
						description: serverDescription(server),
						onSelect: (navigation: CommandFlowNavigation) =>
							navigation.push(inspectServerFlow(snapshot, server.id)),
					}))
				: [{ id: "empty", label: "No configured MCP Servers", disabledReason: "Nothing to inspect" }],
	};
}

function inspectServerFlow(snapshot: McpCommandSnapshot, serverId: string): CommandFlowMenu {
	const server = snapshot.host.servers.find(({ id }) => id === serverId);
	if (!server) throw new Error(`Unknown MCP Server: ${serverId}`);
	const tools = snapshot.host.tools.filter((tool) => tool.serverId === serverId);
	return {
		id: `mcp-inspect:${serverId}`,
		title: `MCP / Inspect / ${serverId}`,
		filterable: true,
		items:
			tools.length > 0
				? tools.map((tool) => ({
						id: tool.id,
						label: tool.name,
						description: `${tool.remoteName} • ${tool.description}`,
					}))
				: [
						{
							id: "empty",
							label: `No admitted Tools (${server.status})`,
							disabledReason: server.error ?? "No Tools discovered",
						},
					],
	};
}

function reconnectFlow(snapshot: McpCommandSnapshot, options: McpCommandFlowOptions): CommandFlowMenu {
	const reconnectable = snapshot.host.servers.filter(({ status }) => status !== "disabled");
	return {
		id: "mcp-reconnect",
		title: "MCP / Reconnect",
		items:
			reconnectable.length > 0
				? reconnectable.map((server) => ({
						id: server.id,
						label: server.id,
						description: serverDescription(server),
						status: server.status,
						onSelect: async (navigation: CommandFlowNavigation) =>
							navigation.push(statusFlow(await options.reconnect(server.id))),
					}))
				: [{ id: "empty", label: "No reconnectable MCP Servers", disabledReason: "Nothing to reconnect" }],
	};
}
