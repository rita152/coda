import { createHash } from "node:crypto";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type {
	McpConnection,
	McpConnector,
	McpDiagnostic,
	McpHost,
	McpHostSnapshot,
	McpRemoteTool,
	McpServerDefinition,
	McpServerSnapshot,
	McpToolCallRequest,
	McpToolDescriptor,
	McpToolResult,
	McpToolSnapshot,
} from "./types.ts";

const SERVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const MODEL_TOOL_NAME_PATTERN = /[^A-Za-z0-9_-]/gu;
const MIN_MODEL_TOOL_NAME_CHARACTERS = 29;
const TOOL_NAME_COLLISION_CODE = "mcp.tool-name-collision";

export interface McpHostLimits {
	readonly maxToolsPerServer: number;
	readonly maxSchemaBytes: number;
	readonly maxSchemaDepth: number;
	readonly maxSchemaNodes: number;
	readonly maxDescriptionCharacters: number;
	readonly maxModelToolNameCharacters: number;
	readonly maxResultContentItems: number;
	readonly maxResultBytes: number;
}

export const DEFAULT_MCP_HOST_LIMITS: McpHostLimits = Object.freeze({
	maxToolsPerServer: 256,
	maxSchemaBytes: 256 * 1024,
	maxSchemaDepth: 64,
	maxSchemaNodes: 10_000,
	maxDescriptionCharacters: 8_192,
	maxModelToolNameCharacters: 64,
	maxResultContentItems: 256,
	maxResultBytes: 32 * 1024 * 1024,
});

function validateHostLimits(limits: McpHostLimits): void {
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`MCP Host limit ${key} must be a non-negative safe integer`);
		}
	}
	if (limits.maxModelToolNameCharacters < MIN_MODEL_TOOL_NAME_CHARACTERS) {
		throw new Error(`MCP Host limit maxModelToolNameCharacters must be at least ${MIN_MODEL_TOOL_NAME_CHARACTERS}`);
	}
}

interface ConnectedTool {
	readonly descriptor: McpToolDescriptor;
	readonly remote: McpRemoteTool;
	readonly connection: McpConnection;
	readonly validateInput: SchemaValidator;
	readonly validateOutput?: SchemaValidator;
}

interface UnavailableTool {
	readonly serverId: string;
	readonly error: string;
}

type SchemaValidator = (
	input: unknown,
) =>
	| { readonly valid: true; readonly data: unknown; readonly errorMessage: undefined }
	| { readonly valid: false; readonly data: undefined; readonly errorMessage: string };

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

function emptySnapshot(): McpHostSnapshot {
	return deepFreeze({ revision: 0, servers: [], tools: [], diagnostics: [] });
}

function toolId(serverId: string, remoteName: string): string {
	return `mcp:${encodeURIComponent(serverId)}:${encodeURIComponent(remoteName)}`;
}

function modelToolName(serverId: string, remoteName: string, maxLength: number): string {
	const normalized = remoteName.replace(MODEL_TOOL_NAME_PATTERN, "_");
	const remoteHash = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
	const serverHash = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
	const hashSuffixLength = 10;
	const fixedLength = "mcp__".length + "__".length;
	const maximumServerLength = maxLength - fixedLength - 1 - hashSuffixLength;
	if (maximumServerLength < hashSuffixLength + 1) {
		throw new Error("MCP model Tool-name limit is too small for stable namespacing");
	}
	const serverSegment =
		serverId.length <= maximumServerLength
			? serverId
			: `${serverId.slice(0, maximumServerLength - hashSuffixLength)}__${serverHash}`;
	const prefix = `mcp__${serverSegment}__`;
	const changed = normalized !== remoteName;
	const suffix = changed || prefix.length + normalized.length > maxLength ? `__${remoteHash}` : "";
	const available = maxLength - prefix.length - suffix.length;
	if (available < 1) throw new Error(`MCP Server id "${serverId}" is too long for a model Tool name`);
	return `${prefix}${normalized.slice(0, available)}${suffix}`;
}

function descriptor(serverId: string, remote: McpRemoteTool, limits: McpHostLimits): McpToolDescriptor {
	return deepFreeze({
		id: toolId(serverId, remote.name),
		serverId,
		remoteName: remote.name,
		name: modelToolName(serverId, remote.name, limits.maxModelToolNameCharacters),
		...(remote.title ? { title: remote.title } : {}),
		description: (remote.description ?? remote.title ?? remote.name).slice(0, limits.maxDescriptionCharacters),
		inputSchema: structuredClone(remote.inputSchema),
		...(remote.outputSchema ? { outputSchema: structuredClone(remote.outputSchema) } : {}),
		...(remote.annotations ? { annotations: structuredClone(remote.annotations) } : {}),
	});
}

function globPattern(pattern: string): RegExp {
	let source = "^";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
	}
	return new RegExp(`${source}$`, "u");
}

function admittedByFilter(name: string, definition: McpServerDefinition): boolean {
	const include = definition.tools?.include;
	if (include && include.length > 0 && !include.some((pattern) => globPattern(pattern).test(name))) return false;
	return !(definition.tools?.exclude ?? []).some((pattern) => globPattern(pattern).test(name));
}

function projectToolCatalog(
	catalog: ReadonlyMap<string, ConnectedTool>,
	baseDiagnostics: readonly McpDiagnostic[],
): { readonly tools: Map<string, ConnectedTool>; readonly diagnostics: readonly McpDiagnostic[] } {
	const byModelName = new Map<string, ConnectedTool[]>();
	for (const tool of catalog.values()) {
		const candidates = byModelName.get(tool.descriptor.name) ?? [];
		candidates.push(tool);
		byModelName.set(tool.descriptor.name, candidates);
	}
	const tools = new Map(catalog);
	const collisionDiagnostics: McpDiagnostic[] = [];
	const collisions = [...byModelName.entries()]
		.filter(([, candidates]) => candidates.length > 1)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	for (const [name, candidates] of collisions) {
		for (const tool of [...candidates].sort((left, right) =>
			left.descriptor.id < right.descriptor.id ? -1 : left.descriptor.id > right.descriptor.id ? 1 : 0,
		)) {
			tools.delete(tool.descriptor.id);
			collisionDiagnostics.push({
				serverId: tool.descriptor.serverId,
				toolName: tool.descriptor.remoteName,
				code: TOOL_NAME_COLLISION_CODE,
				message: `Model Tool name "${name}" collides after normalization; every colliding Tool was quarantined`,
			});
		}
	}
	return {
		tools,
		diagnostics: [
			...baseDiagnostics.filter(({ code }) => code !== TOOL_NAME_COLLISION_CODE),
			...collisionDiagnostics,
		],
	};
}

function withVisibleToolCounts(
	servers: readonly McpServerSnapshot[],
	tools: ReadonlyMap<string, ConnectedTool>,
): readonly McpServerSnapshot[] {
	const counts = new Map<string, number>();
	for (const tool of tools.values()) {
		counts.set(tool.descriptor.serverId, (counts.get(tool.descriptor.serverId) ?? 0) + 1);
	}
	return servers.map((server) => ({ ...server, toolCount: counts.get(server.id) ?? 0 }));
}

function validateSchema(
	label: "inputSchema" | "outputSchema",
	schema: Readonly<Record<string, unknown>>,
	limits: McpHostLimits,
): void {
	if (label === "inputSchema" && schema.type !== "object") {
		throw new Error("inputSchema root type must be object");
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(schema);
	} catch {
		throw new Error(`${label} is not JSON-serializable`);
	}
	if (new TextEncoder().encode(serialized).byteLength > limits.maxSchemaBytes) {
		throw new Error(`${label} exceeds the Schema byte limit`);
	}
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: schema, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		const { value, depth } = pending.pop()!;
		if (++nodes > limits.maxSchemaNodes) throw new Error(`${label} exceeds the Schema node limit`);
		if (depth > limits.maxSchemaDepth) throw new Error(`${label} exceeds the Schema depth limit`);
		if (typeof value !== "object" || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) pending.push({ value: item, depth: depth + 1 });
			continue;
		}
		for (const [key, child] of Object.entries(value)) {
			if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#"))) {
				throw new Error(`${label} contains a non-local $ref`);
			}
			pending.push({ value: child, depth: depth + 1 });
		}
	}
}

function validateDefinitions(definitions: readonly McpServerDefinition[]): void {
	const ids = new Set<string>();
	for (const definition of definitions) {
		if (!SERVER_ID_PATTERN.test(definition.id)) {
			throw new Error(`Invalid MCP Server id "${definition.id}"`);
		}
		if (ids.has(definition.id)) throw new Error(`Duplicate MCP Server id "${definition.id}"`);
		ids.add(definition.id);
	}
}

export function createMcpHost(options: {
	readonly connector: McpConnector;
	readonly limits?: Partial<McpHostLimits>;
}): McpHost {
	const limits: McpHostLimits = Object.freeze({ ...DEFAULT_MCP_HOST_LIMITS, ...options.limits });
	validateHostLimits(limits);
	const schemas = new AjvJsonSchemaValidator();
	let current = emptySnapshot();
	let revision = 0;
	let connections = new Map<string, McpConnection>();
	let configuredDefinitions = new Map<string, McpServerDefinition>();
	let catalogTools = new Map<string, ConnectedTool>();
	let tools = new Map<string, ConnectedTool>();
	let unavailableTools = new Map<string, UnavailableTool>();
	const dirtyServers = new Set<string>();
	const listeners = new Set<(snapshot: McpHostSnapshot) => void>();
	let transitionTail: Promise<void> = Promise.resolve();
	let closed = false;

	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = transitionTail.then(operation, operation);
		transitionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const assertOpen = (): void => {
		if (closed) throw new Error("MCP Host is closed");
	};

	const closeConnections = async (closing: Iterable<McpConnection>): Promise<void> => {
		const results = await Promise.allSettled([...closing].map((connection) => connection.close()));
		const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
	};
	const publish = (snapshot: McpHostSnapshot): McpHostSnapshot => {
		current = snapshot;
		for (const listener of listeners) {
			try {
				listener(snapshot);
			} catch {
				// Observers cannot make protocol state transitions fail.
			}
		}
		return snapshot;
	};
	const rememberUnavailableTools = (serverId: string, error: string): void => {
		for (const [id, tool] of catalogTools) {
			if (tool.descriptor.serverId !== serverId) continue;
			unavailableTools.set(id, { serverId, error });
			catalogTools.delete(id);
		}
	};
	const clearUnavailableTools = (serverId: string): void => {
		for (const [id, unavailable] of unavailableTools) {
			if (unavailable.serverId === serverId) unavailableTools.delete(id);
		}
	};
	const markUnavailable = (serverId: string, error?: Error, code = "mcp.server-unavailable"): void => {
		const serverIndex = current.servers.findIndex((server) => server.id === serverId);
		if (serverIndex < 0) return;
		const message = error?.message || "connection closed";
		connections.delete(serverId);
		dirtyServers.delete(serverId);
		rememberUnavailableTools(serverId, message);
		const serverStates = current.servers.map((server, index) =>
			index === serverIndex ? { id: serverId, status: "degraded" as const, toolCount: 0, error: message } : server,
		);
		const projected = projectToolCatalog(catalogTools, [
			...current.diagnostics.filter((diagnostic) => diagnostic.serverId !== serverId),
			{ serverId, code, message },
		]);
		tools = projected.tools;
		publish(
			deepFreeze({
				revision: ++revision,
				servers: withVisibleToolCounts(serverStates, tools),
				tools: [...tools.values()].map(({ descriptor: value }) => value),
				diagnostics: projected.diagnostics,
			}),
		);
	};
	const connect = async (
		definition: McpServerDefinition,
		context?: { readonly signal?: AbortSignal },
	): Promise<{
		readonly connection: McpConnection;
		readonly assertOpen: () => void;
		readonly activate: () => void;
	}> => {
		let observed: McpConnection | undefined;
		let changedBeforeActivation = false;
		let closedBeforeActivation: Error | undefined;
		observed = await options.connector.connect(definition, {
			...(context?.signal ? { signal: context.signal } : {}),
			onToolsChanged: () => {
				if (observed && connections.get(definition.id) === observed) dirtyServers.add(definition.id);
				else changedBeforeActivation = true;
			},
			onClose: (error) => {
				const normalized = error ?? new Error("connection closed");
				if (observed && connections.get(definition.id) === observed) markUnavailable(definition.id, normalized);
				else closedBeforeActivation ??= normalized;
			},
		});
		return {
			connection: observed,
			assertOpen: () => {
				if (closedBeforeActivation) throw closedBeforeActivation;
			},
			activate: () => {
				if (changedBeforeActivation) dirtyServers.add(definition.id);
			},
		};
	};
	const admitTools = (
		definition: McpServerDefinition,
		connection: McpConnection,
		remoteTools: readonly McpRemoteTool[],
		target: Map<string, ConnectedTool>,
	): { readonly toolCount: number; readonly diagnostics: readonly McpDiagnostic[] } => {
		const diagnostics: McpDiagnostic[] = [];
		let admittedToolCount = 0;
		for (const remote of remoteTools) {
			if (!admittedByFilter(remote.name, definition)) continue;
			if (admittedToolCount >= limits.maxToolsPerServer) {
				diagnostics.push({
					serverId: definition.id,
					toolName: remote.name,
					code: "mcp.tool-limit-exceeded",
					message: `Server exceeds the ${limits.maxToolsPerServer} Tool limit`,
				});
				continue;
			}
			let validateInput: SchemaValidator;
			let validateOutput: SchemaValidator | undefined;
			try {
				validateSchema("inputSchema", remote.inputSchema, limits);
				if (remote.outputSchema) validateSchema("outputSchema", remote.outputSchema, limits);
				validateInput = schemas.getValidator(remote.inputSchema as JsonSchemaType);
				validateOutput = remote.outputSchema
					? schemas.getValidator(remote.outputSchema as JsonSchemaType)
					: undefined;
			} catch (error) {
				diagnostics.push({
					serverId: definition.id,
					toolName: remote.name,
					code: "mcp.tool-invalid-schema",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const nextDescriptor = descriptor(definition.id, remote, limits);
			if (target.has(nextDescriptor.id)) throw new Error(`Duplicate MCP Tool identity "${nextDescriptor.id}"`);
			target.set(nextDescriptor.id, {
				descriptor: nextDescriptor,
				remote,
				connection,
				validateInput,
				...(validateOutput ? { validateOutput } : {}),
			});
			admittedToolCount++;
		}
		return { toolCount: admittedToolCount, diagnostics };
	};
	const callConnectedTool = async (resolved: ConnectedTool, request: McpToolCallRequest): Promise<McpToolResult> => {
		const input = resolved.validateInput(request.arguments);
		if (!input.valid) {
			throw new Error(
				`Invalid arguments for MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}": ${input.errorMessage}`,
			);
		}
		const result = await resolved.connection.callTool(
			{ name: resolved.remote.name, arguments: structuredClone(request.arguments) },
			{
				...(request.signal ? { signal: request.signal } : {}),
				...(request.onProgress ? { onProgress: request.onProgress } : {}),
				...(request.elicit ? { elicit: request.elicit } : {}),
			},
		);
		if (result.content.length > limits.maxResultContentItems) {
			throw new Error(
				`MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}" exceeded the result content-item limit`,
			);
		}
		let resultBytes: number;
		try {
			resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
		} catch {
			throw new Error(
				`MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}" returned a non-JSON result`,
			);
		}
		if (resultBytes > limits.maxResultBytes) {
			throw new Error(
				`MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}" exceeded the result byte limit`,
			);
		}
		if (resolved.validateOutput && !result.isError) {
			if (result.structuredContent === undefined) {
				throw new Error(
					`MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}" omitted required structuredContent`,
				);
			}
			const output = resolved.validateOutput(result.structuredContent);
			if (!output.valid) {
				throw new Error(
					`MCP Tool "${resolved.descriptor.serverId}/${resolved.remote.name}" returned invalid structuredContent: ${output.errorMessage}`,
				);
			}
		}
		return deepFreeze(structuredClone(result));
	};

	return {
		reload(definitions, context) {
			return serialize(async () => {
				assertOpen();
				validateDefinitions(definitions);
				const previousConnections = connections;
				const nextConnections = new Map<string, McpConnection>();
				const pendingConnections: Array<{ readonly assertOpen: () => void; readonly activate: () => void }> = [];
				const nextDefinitions = new Map<string, McpServerDefinition>();
				const nextCatalogTools = new Map<string, ConnectedTool>();
				const nextUnavailableTools = new Map<string, UnavailableTool>();
				const serverSnapshots: McpServerSnapshot[] = [];
				const diagnostics: McpDiagnostic[] = [];
				try {
					for (const definition of definitions) {
						nextDefinitions.set(definition.id, definition);
						if (definition.enabled === false) {
							serverSnapshots.push({ id: definition.id, status: "disabled", toolCount: 0 });
							continue;
						}
						let connection: McpConnection | undefined;
						let phase: "connection" | "catalog" = "connection";
						try {
							const pending = await connect(definition, context);
							connection = pending.connection;
							const remoteTools = await connection.listTools(context);
							pending.assertOpen();
							phase = "catalog";
							const admission = admitTools(definition, connection, remoteTools, nextCatalogTools);
							nextConnections.set(definition.id, connection);
							pendingConnections.push(pending);
							diagnostics.push(...admission.diagnostics);
							serverSnapshots.push({
								id: definition.id,
								status: "ready",
								protocolEra: connection.info.protocolEra,
								protocolVersion: connection.info.protocolVersion,
								...(connection.info.server ? { server: structuredClone(connection.info.server) } : {}),
								toolCount: admission.toolCount,
							});
						} catch (error) {
							await connection?.close().catch(() => undefined);
							for (const [id, tool] of nextCatalogTools) {
								if (tool.descriptor.serverId === definition.id) nextCatalogTools.delete(id);
							}
							const message = error instanceof Error ? error.message : String(error);
							serverSnapshots.push({
								id: definition.id,
								status: "degraded",
								toolCount: 0,
								error: message,
							});
							diagnostics.push({
								serverId: definition.id,
								code: phase === "catalog" ? "mcp.server-invalid-catalog" : "mcp.server-unavailable",
								message,
							});
							for (const [id, tool] of catalogTools) {
								if (tool.descriptor.serverId === definition.id) {
									nextUnavailableTools.set(id, { serverId: definition.id, error: message });
								}
							}
						}
					}
				} catch (error) {
					await closeConnections(nextConnections.values()).catch(() => undefined);
					throw error;
				}
				connections = nextConnections;
				configuredDefinitions = nextDefinitions;
				catalogTools = nextCatalogTools;
				const projected = projectToolCatalog(catalogTools, diagnostics);
				tools = projected.tools;
				unavailableTools = nextUnavailableTools;
				dirtyServers.clear();
				for (const pending of pendingConnections) pending.activate();
				const snapshot = deepFreeze({
					revision: ++revision,
					servers: withVisibleToolCounts(serverSnapshots, tools),
					tools: [...tools.values()].map(({ descriptor: value }) => value),
					diagnostics: projected.diagnostics,
				});
				const published = publish(snapshot);
				await closeConnections(previousConnections.values()).catch(() => undefined);
				return published;
			});
		},
		refresh(context) {
			return serialize(async () => {
				assertOpen();
				if (dirtyServers.size === 0) return current;
				const refreshing = new Set(dirtyServers);
				const nextCatalogTools = new Map(
					[...catalogTools].filter(([, tool]) => !refreshing.has(tool.descriptor.serverId)),
				);
				const nextServers = current.servers.map((server) => ({ ...server }));
				const nextDiagnostics: McpDiagnostic[] = current.diagnostics
					.filter(
						(diagnostic) => !refreshing.has(diagnostic.serverId) && diagnostic.code !== TOOL_NAME_COLLISION_CODE,
					)
					.map((diagnostic) => ({ ...diagnostic }));
				for (const serverId of refreshing) {
					const connection = connections.get(serverId);
					const definition = configuredDefinitions.get(serverId);
					if (!connection || !definition) continue;
					const index = nextServers.findIndex((server) => server.id === serverId);
					let phase: "connection" | "catalog" = "connection";
					try {
						const remoteTools = await connection.listTools(context);
						if (connections.get(serverId) !== connection)
							throw new Error("connection closed during Tool refresh");
						phase = "catalog";
						const admission = admitTools(definition, connection, remoteTools, nextCatalogTools);
						clearUnavailableTools(serverId);
						nextDiagnostics.push(...admission.diagnostics);
						if (index >= 0) {
							nextServers[index] = {
								id: serverId,
								status: "ready",
								protocolEra: connection.info.protocolEra,
								protocolVersion: connection.info.protocolVersion,
								...(connection.info.server ? { server: structuredClone(connection.info.server) } : {}),
								toolCount: admission.toolCount,
							};
						}
					} catch (error) {
						for (const [id, tool] of nextCatalogTools) {
							if (tool.descriptor.serverId === serverId) nextCatalogTools.delete(id);
						}
						const message = error instanceof Error ? error.message : String(error);
						for (const [id, tool] of catalogTools) {
							if (tool.descriptor.serverId === serverId) unavailableTools.set(id, { serverId, error: message });
						}
						nextDiagnostics.push({
							serverId,
							code: phase === "catalog" ? "mcp.server-invalid-catalog" : "mcp.server-unavailable",
							message,
						});
						if (index >= 0)
							nextServers[index] = { id: serverId, status: "degraded", toolCount: 0, error: message };
					}
					dirtyServers.delete(serverId);
				}
				catalogTools = nextCatalogTools;
				const projected = projectToolCatalog(catalogTools, nextDiagnostics);
				tools = projected.tools;
				return publish(
					deepFreeze({
						revision: ++revision,
						servers: withVisibleToolCounts(nextServers, tools),
						tools: [...tools.values()].map(({ descriptor: value }) => value),
						diagnostics: projected.diagnostics,
					}),
				);
			});
		},
		reconnect(serverId, context) {
			return serialize(async () => {
				assertOpen();
				const definition = configuredDefinitions.get(serverId);
				if (!definition) throw new Error(`Unknown MCP Server "${serverId}"`);
				if (definition.enabled === false) throw new Error(`MCP Server "${serverId}" is disabled`);
				const previousConnection = connections.get(serverId);
				let connection: McpConnection | undefined;
				let phase: "connection" | "catalog" = "connection";
				try {
					const pending = await connect(definition, context);
					connection = pending.connection;
					const remoteTools = await connection.listTools(context);
					pending.assertOpen();
					phase = "catalog";
					const nextCatalogTools = new Map(
						[...catalogTools].filter(([, tool]) => tool.descriptor.serverId !== serverId),
					);
					const admission = admitTools(definition, connection, remoteTools, nextCatalogTools);
					connections.set(serverId, connection);
					pending.activate();
					catalogTools = nextCatalogTools;
					clearUnavailableTools(serverId);
					dirtyServers.delete(serverId);
					const servers = current.servers.map((server) =>
						server.id === serverId
							? {
									id: serverId,
									status: "ready" as const,
									protocolEra: connection!.info.protocolEra,
									protocolVersion: connection!.info.protocolVersion,
									...(connection!.info.server ? { server: structuredClone(connection!.info.server) } : {}),
									toolCount: admission.toolCount,
								}
							: server,
					);
					const projected = projectToolCatalog(catalogTools, [
						...current.diagnostics.filter(
							(diagnostic) => diagnostic.serverId !== serverId && diagnostic.code !== TOOL_NAME_COLLISION_CODE,
						),
						...admission.diagnostics,
					]);
					tools = projected.tools;
					const snapshot = publish(
						deepFreeze({
							revision: ++revision,
							servers: withVisibleToolCounts(servers, tools),
							tools: [...tools.values()].map(({ descriptor: value }) => value),
							diagnostics: projected.diagnostics,
						}),
					);
					if (previousConnection && previousConnection !== connection) {
						await previousConnection.close().catch(() => undefined);
					}
					return snapshot;
				} catch (error) {
					await connection?.close().catch(() => undefined);
					if (previousConnection && previousConnection !== connection) {
						await previousConnection.close().catch(() => undefined);
					}
					const normalized = error instanceof Error ? error : new Error(String(error));
					if (previousConnection) connections.delete(serverId);
					markUnavailable(
						serverId,
						normalized,
						phase === "catalog" ? "mcp.server-invalid-catalog" : "mcp.server-unavailable",
					);
					return current;
				}
			});
		},
		snapshot: () => current,
		freezeTools(): McpToolSnapshot {
			assertOpen();
			const frozenRevision = current.revision;
			const frozenTools = new Map(tools);
			return Object.freeze({
				revision: frozenRevision,
				servers: current.servers,
				tools: Object.freeze([...frozenTools.values()].map(({ descriptor: value }) => value)),
				callTool: async (request: McpToolCallRequest) => {
					const resolved = frozenTools.get(request.toolId);
					if (!resolved) throw new Error(`Unknown MCP Tool "${request.toolId}" in revision ${frozenRevision}`);
					return callConnectedTool(resolved, request);
				},
			});
		},
		onDidChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async callTool(request: McpToolCallRequest): Promise<McpToolResult> {
			assertOpen();
			const resolved = tools.get(request.toolId);
			if (!resolved) {
				const unavailable = unavailableTools.get(request.toolId);
				if (unavailable) {
					throw new Error(`MCP Server "${unavailable.serverId}" is unavailable: ${unavailable.error}`);
				}
				throw new Error(`Unknown MCP Tool "${request.toolId}"`);
			}
			return callConnectedTool(resolved, request);
		},
		close() {
			return serialize(async () => {
				if (closed) return;
				closed = true;
				const closing = connections;
				connections = new Map();
				configuredDefinitions = new Map();
				catalogTools = new Map();
				tools = new Map();
				unavailableTools = new Map();
				dirtyServers.clear();
				current = deepFreeze({ revision: ++revision, servers: [], tools: [], diagnostics: [] });
				await closeConnections(closing.values());
			});
		},
	};
}
