import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { McpProtocolPolicy, McpServerDefinition, McpToolFilter } from "@coda/mcp";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";

export const WORKSPACE_MCP_CONFIGURATION_PATH = join(".coda", "mcp.json");

const SERVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_CONFIGURATION_BYTES = 1024 * 1024;

export interface McpStdioConfiguration {
	readonly kind: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly environmentFrom?: readonly string[];
}

export interface McpHttpConfiguration {
	readonly kind: "http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly bearerTokenEnvironment?: string;
}

export interface McpServerConfiguration {
	readonly id: string;
	readonly enabled?: boolean;
	readonly protocol?: McpProtocolPolicy;
	readonly transport: McpStdioConfiguration | McpHttpConfiguration;
	readonly tools?: McpToolFilter;
}

export interface WorkspaceMcpTrustRecord {
	readonly workspace: string;
	readonly path: string;
	readonly sha256: string;
}

export interface WorkspaceMcpConfigurationSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly trust: "trusted" | "untrusted";
	readonly serverCount: number;
	readonly servers: readonly McpServerConfiguration[];
}

export interface InspectedMcpConfiguration {
	readonly definitions: readonly McpServerDefinition[];
	readonly workspace?: WorkspaceMcpConfigurationSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknown) throw new Error(`${label} contains an unknown field: ${unknown}`);
}

function parseStringArray(value: unknown, label: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return Object.freeze([...value]);
}

function parseStringRecord(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
		throw new Error(`${label} must contain only string values`);
	}
	return Object.freeze({ ...(value as Record<string, string>) });
}

function parseTools(value: unknown, label: string): McpToolFilter | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	requireOnlyKeys(value, ["include", "exclude"], label);
	const include = parseStringArray(value.include, `${label}.include`);
	const exclude = parseStringArray(value.exclude, `${label}.exclude`);
	return Object.freeze({ ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) });
}

function parseTransport(value: unknown, label: string): McpStdioConfiguration | McpHttpConfiguration {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (value.kind === "stdio") {
		requireOnlyKeys(value, ["kind", "command", "args", "cwd", "environment", "environmentFrom"], label);
		if (typeof value.command !== "string" || value.command.length === 0) {
			throw new Error(`${label}.command must be a non-empty string`);
		}
		if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
			throw new Error(`${label}.cwd must be a non-empty string`);
		}
		const args = parseStringArray(value.args, `${label}.args`);
		const environment = parseStringRecord(value.environment, `${label}.environment`);
		if (environment && Object.keys(environment).some((name) => !ENVIRONMENT_NAME_PATTERN.test(name))) {
			throw new Error(`${label}.environment contains an invalid environment variable name`);
		}
		const environmentFrom = parseStringArray(value.environmentFrom, `${label}.environmentFrom`);
		if (environmentFrom?.some((name) => !ENVIRONMENT_NAME_PATTERN.test(name))) {
			throw new Error(`${label}.environmentFrom contains an invalid environment variable name`);
		}
		return Object.freeze({
			kind: "stdio" as const,
			command: value.command,
			...(args ? { args } : {}),
			...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
			...(environment ? { environment } : {}),
			...(environmentFrom ? { environmentFrom: Object.freeze([...new Set(environmentFrom)]) } : {}),
		});
	}
	if (value.kind === "http") {
		requireOnlyKeys(value, ["kind", "url", "headers", "bearerTokenEnvironment"], label);
		if (typeof value.url !== "string" || value.url.length === 0) {
			throw new Error(`${label}.url must be a non-empty string`);
		}
		let url: URL;
		try {
			url = new URL(value.url);
		} catch {
			throw new Error(`${label}.url must be a valid URL`);
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
			throw new Error(`${label}.url must be an http(s) URL without credentials or a fragment`);
		}
		const headers = parseStringRecord(value.headers, `${label}.headers`);
		if (headers) {
			for (const [name, headerValue] of Object.entries(headers)) {
				if (/^(?:proxy-)?authorization$/iu.test(name)) {
					throw new Error(`${label}.headers must use bearerTokenEnvironment for authorization`);
				}
				if (/\r|\n/u.test(name) || /\r|\n/u.test(headerValue)) {
					throw new Error(`${label}.headers must not contain line breaks`);
				}
				if (/^(?:mcp-protocol-version|mcp-method|mcp-name|mcp-param-.+)$/iu.test(name)) {
					throw new Error(`${label}.headers must not override MCP protocol headers`);
				}
			}
		}
		if (
			value.bearerTokenEnvironment !== undefined &&
			(typeof value.bearerTokenEnvironment !== "string" ||
				!ENVIRONMENT_NAME_PATTERN.test(value.bearerTokenEnvironment))
		) {
			throw new Error(`${label}.bearerTokenEnvironment must be an environment variable name`);
		}
		return Object.freeze({
			kind: "http" as const,
			url: value.url,
			...(headers ? { headers } : {}),
			...(typeof value.bearerTokenEnvironment === "string"
				? { bearerTokenEnvironment: value.bearerTokenEnvironment }
				: {}),
		});
	}
	throw new Error(`${label}.kind must be "stdio" or "http"`);
}

export function parseMcpServerConfigurations(value: unknown, label: string): readonly McpServerConfiguration[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const ids = new Set<string>();
	return Object.freeze(
		value.map((entry, index) => {
			const entryLabel = `${label}[${index}]`;
			if (!isRecord(entry)) throw new Error(`${entryLabel} must be an object`);
			requireOnlyKeys(entry, ["id", "enabled", "protocol", "transport", "tools"], entryLabel);
			if (typeof entry.id !== "string" || !SERVER_ID_PATTERN.test(entry.id)) {
				throw new Error(`${entryLabel}.id is invalid`);
			}
			if (ids.has(entry.id)) throw new Error(`Duplicate MCP Server id "${entry.id}" in ${label}`);
			ids.add(entry.id);
			if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
				throw new Error(`${entryLabel}.enabled must be a boolean`);
			}
			if (
				entry.protocol !== undefined &&
				entry.protocol !== "2026-07-28" &&
				entry.protocol !== "auto" &&
				entry.protocol !== "legacy"
			) {
				throw new Error(`${entryLabel}.protocol is invalid`);
			}
			const transport = parseTransport(entry.transport, `${entryLabel}.transport`);
			const tools = parseTools(entry.tools, `${entryLabel}.tools`);
			return Object.freeze({
				id: entry.id,
				...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
				...(typeof entry.protocol === "string" ? { protocol: entry.protocol as McpProtocolPolicy } : {}),
				transport,
				...(tools ? { tools } : {}),
			});
		}),
	);
}

function definitionFor(
	configuration: McpServerConfiguration,
	workspace: string,
	environment: Readonly<Record<string, string | undefined>>,
): McpServerDefinition {
	const protocol = configuration.protocol ?? (configuration.transport.kind === "http" ? "auto" : "2026-07-28");
	if (configuration.transport.kind === "http") {
		const tokenName = configuration.transport.bearerTokenEnvironment;
		return Object.freeze({
			id: configuration.id,
			protocol,
			transport: Object.freeze({
				kind: "http" as const,
				url: configuration.transport.url,
				...(configuration.transport.headers ? { headers: configuration.transport.headers } : {}),
				...(tokenName ? { bearerToken: async () => environment[tokenName] } : {}),
			}),
			...(configuration.enabled !== undefined ? { enabled: configuration.enabled } : {}),
			...(configuration.tools ? { tools: configuration.tools } : {}),
		});
	}
	const inherited = Object.fromEntries(
		(configuration.transport.environmentFrom ?? []).flatMap((name) =>
			environment[name] === undefined ? [] : [[name, environment[name]!]],
		),
	);
	const childEnvironment = { ...inherited, ...(configuration.transport.environment ?? {}) };
	const configuredCwd = configuration.transport.cwd;
	const cwd = configuredCwd
		? isAbsolute(configuredCwd)
			? configuredCwd
			: resolve(workspace, configuredCwd)
		: workspace;
	return Object.freeze({
		id: configuration.id,
		protocol,
		transport: Object.freeze({
			kind: "stdio" as const,
			command: configuration.transport.command,
			...(configuration.transport.args ? { args: configuration.transport.args } : {}),
			cwd,
			...(Object.keys(childEnvironment).length > 0 ? { environment: Object.freeze(childEnvironment) } : {}),
		}),
		...(configuration.enabled !== undefined ? { enabled: configuration.enabled } : {}),
		...(configuration.tools ? { tools: configuration.tools } : {}),
	});
}

async function workspaceConfiguration(
	workspace: string,
	fileSystem: FileSystem,
): Promise<
	{ readonly path: string; readonly sha256: string; readonly servers: readonly McpServerConfiguration[] } | undefined
> {
	const path = join(workspace, WORKSPACE_MCP_CONFIGURATION_PATH);
	let bytes: Uint8Array;
	try {
		bytes = await fileSystem.readFile(path);
	} catch (error) {
		if (
			isFileSystemError(error, "ENOENT") ||
			isFileSystemError(error, "ENOTDIR") ||
			isFileSystemError(error, "EACCES")
		) {
			return undefined;
		}
		throw error;
	}
	if (bytes.byteLength > MAX_CONFIGURATION_BYTES) throw new Error("Workspace MCP configuration exceeds 1 MiB");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("Workspace MCP configuration is not valid UTF-8");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Workspace MCP configuration is not valid JSON");
	}
	if (!isRecord(parsed) || parsed.version !== 1) {
		throw new Error("Unsupported or invalid Workspace MCP configuration format");
	}
	requireOnlyKeys(parsed, ["version", "servers"], "Workspace MCP configuration");
	return {
		path,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		servers: parseMcpServerConfigurations(parsed.servers, "Workspace MCP configuration servers"),
	};
}

export async function inspectMcpConfiguration(options: {
	readonly workspace: string;
	readonly fileSystem: FileSystem;
	readonly userServers: readonly McpServerConfiguration[];
	readonly workspaceTrust: readonly WorkspaceMcpTrustRecord[];
	readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<InspectedMcpConfiguration> {
	const workspace = await workspaceConfiguration(options.workspace, options.fileSystem);
	const trusted =
		workspace !== undefined &&
		options.workspaceTrust.some(
			(record) =>
				record.workspace === options.workspace &&
				record.path === workspace.path &&
				record.sha256 === workspace.sha256,
		);
	const selected = [...options.userServers, ...(trusted && workspace ? workspace.servers : [])];
	const ids = new Set<string>();
	for (const configuration of selected) {
		if (ids.has(configuration.id)) {
			throw new Error(`Duplicate MCP Server id "${configuration.id}" across User and Workspace configuration`);
		}
		ids.add(configuration.id);
	}
	return Object.freeze({
		definitions: Object.freeze(
			selected.map((configuration) => definitionFor(configuration, options.workspace, options.environment)),
		),
		...(workspace
			? {
					workspace: Object.freeze({
						path: workspace.path,
						sha256: workspace.sha256,
						trust: trusted ? ("trusted" as const) : ("untrusted" as const),
						serverCount: workspace.servers.length,
						servers: workspace.servers,
					}),
				}
			: {}),
	});
}
