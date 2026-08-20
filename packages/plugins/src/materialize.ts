import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpStdioTransportDefinition } from "@coda/mcp";
import type { SkillFileSystem } from "@coda/skills";
import type {
	MaterializedPluginMcpServer,
	PluginDiagnostic,
	PluginLoadRequest,
	PluginMcpMaterialization,
	PluginMcpMaterializeOptions,
	PluginMcpServer,
} from "./types.ts";

const PLACEHOLDER = /\$\{PLUGIN_(ROOT|DATA)\}/gu;
const PLUGIN_ROOT_PLACEHOLDER = "${" + "PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${" + "PLUGIN_DATA}";

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function expand(value: string, root: string, dataDirectory: string): string {
	return value.replace(PLACEHOLDER, (_placeholder, name: "ROOT" | "DATA") => (name === "ROOT" ? root : dataDirectory));
}

function setEnvironment(
	environment: Record<string, string>,
	name: string,
	value: string,
	platform: NodeJS.Platform,
): void {
	if (platform === "win32") {
		const normalized = name.toLowerCase();
		for (const existing of Object.keys(environment)) {
			if (existing.toLowerCase() === normalized) delete environment[existing];
		}
	}
	environment[name] = value;
}

interface DirectoryLease {
	readonly path: string;
	readonly device?: string;
	readonly inode?: string;
}

interface FileLease {
	readonly path: string;
	readonly device?: string;
	readonly inode?: string;
}

function sameIdentity(lease: DirectoryLease, status: { readonly device?: string; readonly inode?: string }): boolean {
	return (
		lease.device === undefined ||
		lease.inode === undefined ||
		status.device === undefined ||
		status.inode === undefined ||
		(lease.device === status.device && lease.inode === status.inode)
	);
}

async function acquireDirectoryLease(
	fileSystem: SkillFileSystem,
	path: string,
	label: string,
): Promise<DirectoryLease> {
	const status = await fileSystem.lstat(path);
	if (status.kind !== "directory") throw new Error(`${label} must be a real directory`);
	const canonical = await fileSystem.realpath(path);
	if (relative(path, canonical) !== "") throw new Error(`${label} must be canonical`);
	const canonicalStatus = await fileSystem.lstat(canonical);
	if (canonicalStatus.kind !== "directory" || !sameIdentity({ path: canonical, ...status }, canonicalStatus)) {
		throw new Error(`${label} changed while it was validated`);
	}
	return Object.freeze({
		path: canonical,
		...(canonicalStatus.device === undefined ? {} : { device: canonicalStatus.device }),
		...(canonicalStatus.inode === undefined ? {} : { inode: canonicalStatus.inode }),
	});
}

async function assertDirectoryLease(fileSystem: SkillFileSystem, lease: DirectoryLease, label: string): Promise<void> {
	const status = await fileSystem.lstat(lease.path);
	if (status.kind !== "directory" || !sameIdentity(lease, status)) {
		throw new Error(`${label} changed after it was validated`);
	}
	if (relative(lease.path, await fileSystem.realpath(lease.path)) !== "") {
		throw new Error(`${label} changed after it was validated`);
	}
}

async function canonicalDirectory(fileSystem: SkillFileSystem, path: string, label: string): Promise<DirectoryLease> {
	const canonical = await fileSystem.realpath(path);
	const status = await fileSystem.stat(canonical);
	if (status.kind !== "directory") throw new Error(`${label} is not a directory`);
	return Object.freeze({
		path: canonical,
		...(status.device === undefined ? {} : { device: status.device }),
		...(status.inode === undefined ? {} : { inode: status.inode }),
	});
}

async function assertFileLease(fileSystem: SkillFileSystem, lease: FileLease, label: string): Promise<void> {
	const status = await fileSystem.lstat(lease.path);
	if (status.kind !== "file" || !sameIdentity(lease, status)) {
		throw new Error(`${label} changed after it was validated`);
	}
	if (relative(lease.path, await fileSystem.realpath(lease.path)) !== "") {
		throw new Error(`${label} changed after it was validated`);
	}
}

async function materializeCommand(
	fileSystem: SkillFileSystem,
	root: string,
	command: string,
	platform: NodeJS.Platform,
): Promise<{ readonly value: string; readonly lease?: FileLease }> {
	if (!command.startsWith("./")) {
		if (
			command.includes("/") ||
			(platform === "win32" && (command.includes("\\") || /^[A-Za-z]:/u.test(command))) ||
			isAbsolute(command)
		) {
			throw new Error("command must be a bare executable name or begin with ./");
		}
		return Object.freeze({ value: command });
	}
	const requested = resolve(root, command);
	const canonical = await fileSystem.realpath(requested);
	if (!isContained(root, canonical)) throw new Error("command resolves outside the Plugin root");
	const status = await fileSystem.stat(canonical);
	if (status.kind !== "file") throw new Error("command is not a regular file");
	return Object.freeze({
		value: canonical,
		lease: Object.freeze({
			path: canonical,
			...(status.device === undefined ? {} : { device: status.device }),
			...(status.inode === undefined ? {} : { inode: status.inode }),
		}),
	});
}

async function materializeCwd(
	fileSystem: SkillFileSystem,
	root: string,
	dataDirectory: string,
	configured: string | undefined,
): Promise<{ readonly value: string; readonly lease?: DirectoryLease }> {
	if (configured === undefined) return Object.freeze({ value: root });
	let containmentRoot: string;
	let requested: string;
	if (configured.startsWith("./")) {
		containmentRoot = root;
		requested = resolve(root, expand(configured, root, dataDirectory));
	} else if (configured === PLUGIN_ROOT_PLACEHOLDER || configured.startsWith(`${PLUGIN_ROOT_PLACEHOLDER}/`)) {
		containmentRoot = root;
		requested = expand(configured, root, dataDirectory);
	} else if (configured === PLUGIN_DATA_PLACEHOLDER || configured.startsWith(`${PLUGIN_DATA_PLACEHOLDER}/`)) {
		containmentRoot = dataDirectory;
		requested = expand(configured, root, dataDirectory);
	} else {
		throw new Error(`cwd must begin with ./, ${PLUGIN_ROOT_PLACEHOLDER}, or ${PLUGIN_DATA_PLACEHOLDER}`);
	}
	const lease = await canonicalDirectory(fileSystem, requested, "cwd");
	if (!isContained(containmentRoot, lease.path)) throw new Error("cwd resolves outside its permitted root");
	return Object.freeze({ value: lease.path, lease });
}

function materializeEnvironment(
	configured: Readonly<Record<string, string>> | undefined,
	options: PluginMcpMaterializeOptions,
	root: string,
	dataDirectory: string,
): Readonly<Record<string, string>> {
	const environment: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [name, value] of Object.entries(options.baseEnvironment ?? {})) {
		if (value !== undefined) setEnvironment(environment, name, value, options.platform);
	}
	for (const [name, value] of Object.entries(configured ?? {})) {
		setEnvironment(environment, name, expand(value, root, dataDirectory), options.platform);
	}
	setEnvironment(environment, "PLUGIN_ROOT", root, options.platform);
	setEnvironment(environment, "PLUGIN_DATA", dataDirectory, options.platform);
	return Object.freeze(environment);
}

function diagnostic<Origin>(
	request: PluginLoadRequest<Origin>,
	server: PluginMcpServer<Origin>,
	message: string,
): PluginDiagnostic<Origin> {
	return Object.freeze({
		code: "mcp-server-materialization-failed",
		severity: "warning",
		phase: "mcp",
		message: `Could not materialize MCP Server "${server.name}": ${message}`,
		componentName: server.name,
		pluginRoot: request.root,
		origin: request.origin,
	});
}

export async function materializePluginMcp<Origin>(input: {
	readonly fileSystem: SkillFileSystem;
	readonly request: PluginLoadRequest<Origin>;
	readonly root: string;
	readonly rootIdentity: { readonly device?: string; readonly inode?: string };
	readonly servers: readonly PluginMcpServer<Origin>[];
	readonly options: PluginMcpMaterializeOptions;
}): Promise<PluginMcpMaterialization<Origin>> {
	if (!input.options || typeof input.options !== "object" || typeof input.options.platform !== "string") {
		throw new TypeError("MCP materialization platform is required");
	}
	input.options.signal?.throwIfAborted();
	const hasStdio = input.servers.some(({ configuration }) => configuration.type === "stdio");
	let dataDirectory: string | undefined;
	let dataRootLease: DirectoryLease | undefined;
	let dataDirectoryLease: DirectoryLease | undefined;
	let dataDirectoryError: unknown;
	let runtimeRoot = input.root;
	let pluginRootLease: DirectoryLease | undefined;
	let pluginRootError: unknown;
	if (hasStdio) {
		try {
			pluginRootLease = await acquireDirectoryLease(input.fileSystem, input.root, "Plugin root");
			if (!sameIdentity({ path: input.root, ...input.rootIdentity }, pluginRootLease)) {
				throw new Error("Plugin root was replaced after the Plugin Snapshot was loaded");
			}
			runtimeRoot = pluginRootLease.path;
		} catch (error) {
			input.options.signal?.throwIfAborted();
			pluginRootError = new Error(
				`Plugin root changed after the Plugin Snapshot was loaded: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			if (!input.options.dataRoot || !isAbsolute(input.options.dataRoot)) {
				throw new TypeError("An absolute Plugin dataRoot is required for stdio MCP Servers");
			}
			if (!input.options.dataDirectory || !isAbsolute(input.options.dataDirectory)) {
				throw new TypeError("An absolute Plugin dataDirectory is required for stdio MCP Servers");
			}
			dataRootLease = await acquireDirectoryLease(input.fileSystem, input.options.dataRoot, "Plugin dataRoot");
			dataDirectoryLease = await acquireDirectoryLease(
				input.fileSystem,
				input.options.dataDirectory,
				"Plugin dataDirectory",
			);
			dataDirectory = dataDirectoryLease.path;
			if (!isContained(dataRootLease.path, dataDirectory)) {
				throw new Error("Plugin dataDirectory resolves outside the Plugin dataRoot");
			}
		} catch (error) {
			input.options.signal?.throwIfAborted();
			dataDirectoryError = error;
		}
	}
	const servers: MaterializedPluginMcpServer<Origin>[] = [];
	const diagnostics: PluginDiagnostic<Origin>[] = [];
	for (const server of input.servers) {
		input.options.signal?.throwIfAborted();
		if (server.configuration.type === "streamable-http") {
			servers.push(
				Object.freeze({
					name: server.name,
					pluginName: server.pluginName,
					pluginRoot: server.pluginRoot,
					origin: server.origin,
					transport: Object.freeze({
						kind: "http" as const,
						url: server.configuration.url,
						...(server.configuration.headers ? { headers: server.configuration.headers } : {}),
					}),
				}),
			);
			continue;
		}
		try {
			if (pluginRootError) throw pluginRootError;
			if (!pluginRootLease) throw new Error("Plugin root is unavailable");
			if (dataDirectoryError) throw dataDirectoryError;
			if (!dataRootLease || !dataDirectoryLease || !dataDirectory) {
				throw new Error("Plugin dataDirectory is unavailable");
			}
			await assertDirectoryLease(input.fileSystem, dataRootLease, "Plugin dataRoot");
			await assertDirectoryLease(input.fileSystem, dataDirectoryLease, "Plugin dataDirectory");
			const materializedCommand = await materializeCommand(
				input.fileSystem,
				runtimeRoot,
				server.configuration.command,
				input.options.platform,
			);
			input.options.signal?.throwIfAborted();
			const args = server.configuration.args
				? Object.freeze(server.configuration.args.map((value) => expand(value, runtimeRoot, dataDirectory)))
				: undefined;
			const materializedWorkingDirectory = await materializeCwd(
				input.fileSystem,
				runtimeRoot,
				dataDirectory,
				server.configuration.cwd,
			);
			input.options.signal?.throwIfAborted();
			const assertLaunchLeases = async (signal?: AbortSignal): Promise<void> => {
				signal?.throwIfAborted();
				await assertDirectoryLease(input.fileSystem, pluginRootLease, "Plugin root");
				if (materializedCommand.lease) {
					await assertFileLease(input.fileSystem, materializedCommand.lease, "command");
				}
				if (materializedWorkingDirectory.lease) {
					await assertDirectoryLease(input.fileSystem, materializedWorkingDirectory.lease, "cwd");
				}
				await assertDirectoryLease(input.fileSystem, dataRootLease, "Plugin dataRoot");
				await assertDirectoryLease(input.fileSystem, dataDirectoryLease, "Plugin dataDirectory");
				signal?.throwIfAborted();
			};
			await assertLaunchLeases(input.options.signal);
			const transport: McpStdioTransportDefinition = {
				kind: "stdio" as const,
				command: materializedCommand.value,
				...(args ? { args } : {}),
				cwd: materializedWorkingDirectory.value,
				environment: materializeEnvironment(server.configuration.env, input.options, runtimeRoot, dataDirectory),
			};
			Object.defineProperty(transport, "beforeLaunch", {
				value: assertLaunchLeases,
				enumerable: false,
				configurable: false,
				writable: false,
			});
			Object.freeze(transport);
			servers.push(
				Object.freeze({
					name: server.name,
					pluginName: server.pluginName,
					pluginRoot: server.pluginRoot,
					origin: server.origin,
					transport,
				}),
			);
		} catch (error) {
			input.options.signal?.throwIfAborted();
			diagnostics.push(diagnostic(input.request, server, error instanceof Error ? error.message : String(error)));
		}
	}
	return Object.freeze({ servers: Object.freeze(servers), diagnostics: Object.freeze(diagnostics) });
}
