import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SkillFileSystem } from "@coda/skills";
import type {
	PluginDiagnostic,
	PluginLimits,
	PluginLoadRequest,
	PluginMcpConfiguration,
	PluginMcpHttpConfiguration,
	PluginMcpServer,
	PluginMcpStdioConfiguration,
} from "./types.ts";
import { AGENT_PLUGIN_MCP_SCHEMA } from "./types.ts";

const PLUGIN_ROOT_PLACEHOLDER = "${" + "PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${" + "PLUGIN_DATA}";

interface LoadedPluginMcp<Origin> {
	readonly servers: readonly PluginMcpServer<Origin>[];
	readonly configuration?: PluginMcpConfiguration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as Error & { readonly code?: unknown }).code)
		: undefined;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	code: string,
	severity: PluginDiagnostic<Origin>["severity"],
	message: string,
	path: string,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code,
		severity,
		phase: "mcp",
		message,
		path,
		pluginRoot: request.root,
		origin: request.origin,
	});
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const accepted = new Set(allowed);
	const unknown = Object.keys(value).find((field) => !accepted.has(field));
	if (unknown) throw new Error(`${label} contains an unknown field: ${unknown}`);
}

function stringArray(value: unknown, label: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return Object.freeze([...value]);
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be an object of strings`);
	}
	return Object.freeze({ ...(value as Record<string, string>) });
}

function remoteConfiguration(
	value: Record<string, unknown>,
	type: "streamable-http" | "sse",
	label: string,
): PluginMcpHttpConfiguration {
	requireOnlyKeys(value, ["type", "url", "headers"], label);
	if (typeof value.url !== "string" || value.url.length === 0) throw new Error(`${label}.url must be a string`);
	let url: URL;
	try {
		url = new URL(value.url);
	} catch {
		throw new Error(`${label}.url must be an absolute URL`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
		throw new Error(`${label}.url must be an HTTP(S) URL without credentials or a fragment`);
	}
	const headers = stringRecord(value.headers, `${label}.headers`);
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
		throw new Error(`${label}.url must use HTTPS for a non-loopback endpoint`);
	}
	if (headers) {
		const names = new Set<string>();
		for (const [name, headerValue] of Object.entries(headers)) {
			try {
				validateHeaderName(name);
				validateHeaderValue(name, headerValue);
			} catch {
				throw new Error(`${label}.headers contains an invalid HTTP header`);
			}
			const normalized = name.toLowerCase();
			if (names.has(normalized)) throw new Error(`${label}.headers contains a duplicate header name`);
			names.add(normalized);
		}
	}
	return Object.freeze({
		type: type === "sse" ? "streamable-http" : type,
		url: value.url,
		...(headers ? { headers } : {}),
	});
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	if (host.toLowerCase() === "localhost") return true;
	const version = isIP(host);
	if (version === 4) return host.split(".")[0] === "127";
	return version === 6 && host.toLowerCase() === "::1";
}

function validateCommand(command: string, label: string): void {
	if (command.startsWith("./")) return;
	if (
		command.includes("/") ||
		(process.platform === "win32" && (command.includes("\\") || /^[A-Za-z]:/u.test(command))) ||
		isAbsolute(command)
	) {
		throw new Error(`${label}.command must be a bare executable name or begin with ./`);
	}
}

function validateCwd(cwd: string, label: string): void {
	if (cwd.startsWith("./")) {
		return;
	} else if (cwd === PLUGIN_ROOT_PLACEHOLDER || cwd === PLUGIN_DATA_PLACEHOLDER) {
		return;
	} else if (cwd.startsWith(`${PLUGIN_ROOT_PLACEHOLDER}/`)) {
		return;
	} else if (cwd.startsWith(`${PLUGIN_DATA_PLACEHOLDER}/`)) {
		return;
	}
	throw new Error(`${label}.cwd must begin with ./, ${PLUGIN_ROOT_PLACEHOLDER}, or ${PLUGIN_DATA_PLACEHOLDER}`);
}

function stdioConfiguration(value: Record<string, unknown>, label: string): PluginMcpStdioConfiguration {
	requireOnlyKeys(value, ["type", "command", "args", "env", "cwd"], label);
	if (typeof value.command !== "string" || value.command.length === 0) {
		throw new Error(`${label}.command must be a non-empty string`);
	}
	validateCommand(value.command, label);
	const args = stringArray(value.args, `${label}.args`);
	const env = stringRecord(value.env, `${label}.env`);
	if (env && (Object.hasOwn(env, "PLUGIN_ROOT") || Object.hasOwn(env, "PLUGIN_DATA"))) {
		throw new Error(`${label}.env must not configure PLUGIN_ROOT or PLUGIN_DATA`);
	}
	if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error(`${label}.cwd must be a string`);
	if (typeof value.cwd === "string") validateCwd(value.cwd, label);
	return Object.freeze({
		type: "stdio",
		command: value.command,
		...(args ? { args } : {}),
		...(env ? { env } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
	});
}

function parseServer(
	value: unknown,
	label: string,
): {
	readonly configuration: PluginMcpStdioConfiguration | PluginMcpHttpConfiguration;
	readonly supported: boolean;
} {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (value.type === "stdio")
		return Object.freeze({ configuration: stdioConfiguration(value, label), supported: true });
	if (value.type === "streamable-http") {
		return Object.freeze({ configuration: remoteConfiguration(value, "streamable-http", label), supported: true });
	}
	if (value.type === "sse") {
		return Object.freeze({ configuration: remoteConfiguration(value, "sse", label), supported: false });
	}
	throw new Error(`${label}.type is unsupported or invalid`);
}

export async function loadPluginMcp<Origin>(options: {
	readonly fileSystem: SkillFileSystem;
	readonly request: PluginLoadRequest<Origin>;
	readonly root: string;
	readonly pluginName: string;
	readonly limits: Readonly<PluginLimits>;
	readonly diagnostics: PluginDiagnostic<Origin>[];
}): Promise<LoadedPluginMcp<Origin>> {
	const lexicalPath = join(options.request.root, "mcp.json");
	let present = false;
	let canonicalPath: string;
	let bytes: Uint8Array;
	try {
		await options.fileSystem.lstat(lexicalPath);
		present = true;
		canonicalPath = await options.fileSystem.realpath(lexicalPath);
		if (!isContained(options.root, canonicalPath)) throw new Error("mcp.json resolves outside the Plugin root");
		const status = await options.fileSystem.stat(canonicalPath);
		if (status.kind !== "file") throw new Error("mcp.json is not a regular file");
		if (status.size > options.limits.maxMcpConfigurationBytes) {
			throw new Error(`mcp.json exceeds ${options.limits.maxMcpConfigurationBytes} bytes`);
		}
		bytes = await options.fileSystem.readFile(canonicalPath);
		if (bytes.byteLength > options.limits.maxMcpConfigurationBytes) {
			throw new Error(`mcp.json exceeds ${options.limits.maxMcpConfigurationBytes} bytes`);
		}
		options.request.signal?.throwIfAborted();
	} catch (error) {
		if (!present && errorCode(error) === "ENOENT") return Object.freeze({ servers: Object.freeze([]) });
		options.request.signal?.throwIfAborted();
		options.diagnostics.push(
			diagnostic(
				options.request,
				"mcp-component-invalid",
				"warning",
				`Could not load mcp.json: ${error instanceof Error ? error.message : String(error)}`,
				lexicalPath,
			),
		);
		return Object.freeze({ servers: Object.freeze([]) });
	}
	let parsed: Record<string, unknown>;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) throw new Error("mcp.json must contain an object");
		requireOnlyKeys(value, ["$schema", "mcpServers"], "mcp.json");
		if (value.$schema !== AGENT_PLUGIN_MCP_SCHEMA) {
			throw new Error("mcp.json targets an unsupported or mismatched Agent Plugins version");
		}
		if (!isRecord(value.mcpServers)) throw new Error("mcp.json mcpServers must be an object");
		parsed = value.mcpServers;
	} catch (error) {
		options.diagnostics.push(
			diagnostic(
				options.request,
				"mcp-configuration-invalid",
				"warning",
				`Ignored invalid mcp.json: ${error instanceof Error ? error.message : String(error)}`,
				canonicalPath,
			),
		);
		return Object.freeze({ servers: Object.freeze([]) });
	}
	const servers: PluginMcpServer<Origin>[] = [];
	for (const [name, value] of Object.entries(parsed).sort(([left], [right]) => compareText(left, right))) {
		try {
			const server = parseServer(value, `mcpServers.${name}`);
			if (!server.supported) {
				options.diagnostics.push(
					diagnostic(
						options.request,
						"mcp-transport-unsupported",
						"info",
						`Skipped MCP Server "${name}" because Coda does not support legacy HTTP+SSE`,
						canonicalPath,
					),
				);
				continue;
			}
			servers.push(
				Object.freeze({
					name,
					pluginName: options.pluginName,
					pluginRoot: options.root,
					origin: options.request.origin,
					configuration: server.configuration,
				}),
			);
		} catch (error) {
			options.diagnostics.push(
				diagnostic(
					options.request,
					"mcp-server-invalid",
					"warning",
					`Skipped invalid MCP Server "${name}": ${error instanceof Error ? error.message : String(error)}`,
					canonicalPath,
				),
			);
		}
	}
	return Object.freeze({
		servers: Object.freeze(servers),
		configuration: Object.freeze({
			path: canonicalPath,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		}),
	});
}
