import {
	Client,
	StreamableHTTPClientTransport,
	type Tool,
	type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
	McpCallContext,
	McpConnection,
	McpConnectionInfo,
	McpConnector,
	McpContentMetadata,
	McpElicitationRequest,
	McpElicitationResult,
	McpIcon,
	McpRemoteTool,
	McpServerDefinition,
	McpToolContent,
	McpToolResult,
} from "./types.ts";

const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];

export interface SdkMcpLimits {
	readonly connectTimeoutMs: number;
	readonly listTimeoutMs: number;
	readonly callTimeoutMs: number;
	readonly callTotalTimeoutMs: number;
	readonly listMaxPages: number;
	readonly inputRequiredMaxRounds: number;
	readonly stdioMaxBufferBytes: number;
	readonly maxElicitationMessageCharacters: number;
	readonly maxElicitationUrlCharacters: number;
	readonly maxElicitationSchemaBytes: number;
	readonly maxProgressEvents: number;
	readonly maxProgressMessageCharacters: number;
}

export const DEFAULT_SDK_MCP_LIMITS: SdkMcpLimits = Object.freeze({
	connectTimeoutMs: 10_000,
	listTimeoutMs: 30_000,
	callTimeoutMs: 60_000,
	callTotalTimeoutMs: 120_000,
	listMaxPages: 64,
	inputRequiredMaxRounds: 10,
	stdioMaxBufferBytes: 10 * 1024 * 1024,
	maxElicitationMessageCharacters: 16_384,
	maxElicitationUrlCharacters: 8_192,
	maxElicitationSchemaBytes: 256 * 1024,
	maxProgressEvents: 1_000,
	maxProgressMessageCharacters: 2_048,
});

export interface SdkMcpConnectorOptions {
	readonly fetch?: typeof globalThis.fetch;
	readonly client?: { readonly name: string; readonly version: string };
	readonly limits?: Partial<SdkMcpLimits>;
	readonly onError?: (serverId: string, error: Error) => void;
	readonly onStderr?: (serverId: string, chunk: string) => void;
}

function versionNegotiation(definition: McpServerDefinition): VersionNegotiationOptions {
	switch (definition.protocol) {
		case "2026-07-28":
			return { mode: { pin: "2026-07-28" } };
		case "auto":
			return { mode: "auto" };
		case "legacy":
			return { mode: "legacy" };
	}
}

function httpTransport(
	definition: McpServerDefinition,
	fetch: typeof globalThis.fetch | undefined,
): StreamableHTTPClientTransport {
	if (definition.transport.kind !== "http") throw new Error("SDK HTTP connector requires an HTTP transport");
	const url = new URL(definition.transport.url);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`MCP HTTP URL must use http or https: ${definition.transport.url}`);
	}
	if (url.username || url.password || url.hash) {
		throw new Error(`MCP HTTP URL must not contain credentials or a fragment: ${definition.transport.url}`);
	}
	return new StreamableHTTPClientTransport(url, {
		...(fetch ? { fetch } : {}),
		...(definition.transport.headers ? { requestInit: { headers: { ...definition.transport.headers } } } : {}),
		...(definition.transport.bearerToken ? { authProvider: { token: definition.transport.bearerToken } } : {}),
	});
}

function stdioTransport(
	definition: McpServerDefinition,
	limits: SdkMcpLimits,
	onStderr: SdkMcpConnectorOptions["onStderr"],
): StdioClientTransport {
	if (definition.transport.kind !== "stdio") throw new Error("SDK stdio connector requires a stdio transport");
	if (!definition.transport.command) throw new Error(`MCP stdio Server "${definition.id}" requires a command`);
	// The SDK merges a small ambient allowlist even when `env` is supplied. Explicit
	// undefined overrides make Node omit those keys unless the Host admitted them.
	const environment = Object.fromEntries(
		DEFAULT_INHERITED_ENV_VARS.map((name) => [name, undefined]),
	) as unknown as Record<string, string>;
	Object.assign(environment, definition.transport.environment ?? {});
	const transport = new StdioClientTransport({
		command: definition.transport.command,
		...(definition.transport.args ? { args: [...definition.transport.args] } : {}),
		...(definition.transport.cwd ? { cwd: definition.transport.cwd } : {}),
		env: environment,
		stderr: "pipe",
		maxBufferSize: limits.stdioMaxBufferBytes,
	});
	transport.stderr?.on("data", (chunk: Buffer | string) => onStderr?.(definition.id, String(chunk)));
	return transport;
}

function normalizeTool(tool: Tool): McpRemoteTool {
	return {
		name: tool.name,
		...(tool.title ? { title: tool.title } : {}),
		...(tool.description ? { description: tool.description } : {}),
		inputSchema: structuredClone(tool.inputSchema),
		...(tool.outputSchema ? { outputSchema: structuredClone(tool.outputSchema) } : {}),
		...(tool.annotations ? { annotations: structuredClone(tool.annotations) } : {}),
		...(tool._meta ? { meta: structuredClone(tool._meta) } : {}),
	};
}

function clonedRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? structuredClone(value as Record<string, unknown>)
		: undefined;
}

function normalizeContentMetadata(value: Record<string, unknown>): McpContentMetadata {
	const annotations = clonedRecord(value.annotations);
	const meta = clonedRecord(value._meta);
	return {
		...(annotations ? { annotations } : {}),
		...(meta ? { meta } : {}),
	};
}

function normalizeIcons(value: unknown): readonly McpIcon[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("MCP Tool returned invalid resource icons");
	return value.map((raw) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof raw.src !== "string") {
			throw new Error("MCP Tool returned an invalid resource icon");
		}
		return {
			src: raw.src,
			...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
			...(Array.isArray(raw.sizes) && raw.sizes.every((size: unknown) => typeof size === "string")
				? { sizes: [...raw.sizes] }
				: {}),
			...(raw.theme === "light" || raw.theme === "dark" ? { theme: raw.theme } : {}),
		};
	});
}

function normalizeContent(content: unknown): McpToolContent {
	if (typeof content !== "object" || content === null || !("type" in content)) {
		throw new Error("MCP Tool returned invalid content");
	}
	const value = content as Record<string, unknown>;
	const metadata = normalizeContentMetadata(value);
	switch (value.type) {
		case "text":
			return { type: "text", text: String(value.text), ...metadata };
		case "image":
			return { type: "image", data: String(value.data), mimeType: String(value.mimeType), ...metadata };
		case "audio":
			return { type: "audio", data: String(value.data), mimeType: String(value.mimeType), ...metadata };
		case "resource_link":
			return {
				type: "resource_link",
				uri: String(value.uri),
				...(typeof value.name === "string" ? { name: value.name } : {}),
				...(typeof value.title === "string" ? { title: value.title } : {}),
				...(typeof value.description === "string" ? { description: value.description } : {}),
				...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
				...(typeof value.size === "number" ? { size: value.size } : {}),
				...(value.icons !== undefined ? { icons: normalizeIcons(value.icons)! } : {}),
				...metadata,
			};
		case "resource": {
			const resource = value.resource;
			if (typeof resource !== "object" || resource === null || !("uri" in resource)) {
				throw new Error("MCP Tool returned an invalid embedded resource");
			}
			const embedded = resource as Record<string, unknown>;
			const embeddedMeta = clonedRecord(embedded._meta);
			if (typeof embedded.text === "string") {
				return {
					type: "resource",
					resource: {
						uri: String(embedded.uri),
						...(typeof embedded.mimeType === "string" ? { mimeType: embedded.mimeType } : {}),
						text: embedded.text,
						...(embeddedMeta ? { meta: embeddedMeta } : {}),
					},
					...metadata,
				};
			}
			if (typeof embedded.blob === "string") {
				return {
					type: "resource",
					resource: {
						uri: String(embedded.uri),
						...(typeof embedded.mimeType === "string" ? { mimeType: embedded.mimeType } : {}),
						blob: embedded.blob,
						...(embeddedMeta ? { meta: embeddedMeta } : {}),
					},
					...metadata,
				};
			}
			throw new Error("MCP Tool returned an embedded resource without text or blob content");
		}
		default:
			throw new Error(`MCP Tool returned unsupported content type "${String(value.type)}"`);
	}
}

function normalizeElicitationRequest(params: Record<string, unknown>, limits: SdkMcpLimits): McpElicitationRequest {
	if (typeof params.message !== "string") throw new Error("MCP Elicitation message must be a string");
	if (params.message.length > limits.maxElicitationMessageCharacters) {
		throw new Error("MCP Elicitation message exceeds the configured character limit");
	}
	if (params.mode === "url") {
		if (typeof params.url !== "string") throw new Error("MCP URL Elicitation requires a URL");
		if (params.url.length > limits.maxElicitationUrlCharacters) {
			throw new Error("MCP Elicitation URL exceeds the configured character limit");
		}
		return { mode: "url", message: params.message, url: params.url };
	}
	if (params.mode !== undefined && params.mode !== "form") {
		throw new Error(`Unsupported MCP Elicitation mode "${String(params.mode)}"`);
	}
	if (
		typeof params.requestedSchema !== "object" ||
		params.requestedSchema === null ||
		Array.isArray(params.requestedSchema)
	) {
		throw new Error("MCP form Elicitation requires an object Schema");
	}
	const requestedSchema = structuredClone(params.requestedSchema as Record<string, unknown>);
	let serialized: string;
	try {
		serialized = JSON.stringify(requestedSchema);
	} catch {
		throw new Error("MCP Elicitation Schema is not JSON-serializable");
	}
	if (new TextEncoder().encode(serialized).byteLength > limits.maxElicitationSchemaBytes) {
		throw new Error("MCP Elicitation Schema exceeds the configured byte limit");
	}
	return {
		mode: "form",
		message: params.message,
		requestedSchema,
	};
}

function validateLimits(limits: SdkMcpLimits): void {
	const positiveIntegers: readonly (keyof SdkMcpLimits)[] = [
		"connectTimeoutMs",
		"listTimeoutMs",
		"callTimeoutMs",
		"callTotalTimeoutMs",
		"listMaxPages",
		"inputRequiredMaxRounds",
		"stdioMaxBufferBytes",
		"maxElicitationMessageCharacters",
		"maxElicitationUrlCharacters",
		"maxElicitationSchemaBytes",
		"maxProgressEvents",
		"maxProgressMessageCharacters",
	];
	for (const key of positiveIntegers) {
		const value = limits[key];
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`MCP SDK limit ${key} must be a positive safe integer`);
		}
	}
	if (limits.callTotalTimeoutMs < limits.callTimeoutMs) {
		throw new Error("MCP SDK limit callTotalTimeoutMs must be greater than or equal to callTimeoutMs");
	}
}

class SdkMcpConnection implements McpConnection {
	readonly info: McpConnectionInfo;
	readonly #client: Client;
	readonly #limits: SdkMcpLimits;
	#tools = new Map<string, Tool>();
	#activeCall?: McpCallContext;
	#callTail: Promise<void> = Promise.resolve();

	constructor(client: Client, info: McpConnectionInfo, limits: SdkMcpLimits) {
		this.#client = client;
		this.info = info;
		this.#limits = limits;
		client.setRequestHandler("elicitation/create", async (request) => {
			const handler = this.#activeCall?.elicit;
			if (!handler) return { action: "decline" };
			const result: McpElicitationResult = await handler(
				normalizeElicitationRequest(request.params as Record<string, unknown>, this.#limits),
			);
			return structuredClone(result) as {
				action: "accept" | "decline" | "cancel";
				content?: Record<string, string | number | boolean | string[]>;
			};
		});
	}

	async listTools(context?: { readonly signal?: AbortSignal }): Promise<readonly McpRemoteTool[]> {
		const result = await this.#client.listTools(undefined, {
			...(context?.signal ? { signal: context.signal } : {}),
			timeout: this.#limits.listTimeoutMs,
			maxTotalTimeout: this.#limits.listTimeoutMs,
			cacheMode: "refresh",
		});
		this.#tools = new Map(result.tools.map((tool) => [tool.name, tool]));
		return result.tools.map(normalizeTool);
	}

	async callTool(
		request: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
		context: McpCallContext = {},
	): Promise<McpToolResult> {
		const execute = async (): Promise<McpToolResult> => {
			this.#activeCall = context;
			try {
				const tool = this.#tools.get(request.name);
				let progressEvents = 0;
				let lastProgress = Number.NEGATIVE_INFINITY;
				const result = await this.#client.callTool(
					{ name: request.name, arguments: structuredClone(request.arguments) },
					{
						...(context.signal ? { signal: context.signal } : {}),
						...(context.onProgress
							? {
									onprogress: (progress) => {
										if (
											progressEvents >= this.#limits.maxProgressEvents ||
											!Number.isFinite(progress.progress) ||
											progress.progress < lastProgress ||
											(progress.total !== undefined && !Number.isFinite(progress.total))
										) {
											return;
										}
										progressEvents++;
										lastProgress = progress.progress;
										try {
											context.onProgress?.({
												progress: progress.progress,
												...(progress.total !== undefined ? { total: progress.total } : {}),
												...(progress.message !== undefined
													? {
															message: progress.message.slice(
																0,
																this.#limits.maxProgressMessageCharacters,
															),
														}
													: {}),
											});
										} catch {
											// A presentation observer cannot fail the protocol call.
										}
									},
								}
							: {}),
						timeout: this.#limits.callTimeoutMs,
						maxTotalTimeout: this.#limits.callTotalTimeoutMs,
						...(tool ? { toolDefinition: tool } : {}),
					},
				);
				return {
					isError: result.isError ?? false,
					content: result.content.map(normalizeContent),
					...(result.structuredContent !== undefined
						? { structuredContent: structuredClone(result.structuredContent) }
						: {}),
					...(result._meta ? { meta: structuredClone(result._meta) } : {}),
				};
			} finally {
				this.#activeCall = undefined;
			}
		};
		const operation = this.#callTail.then(execute, execute);
		this.#callTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	close(): Promise<void> {
		return this.#client.close();
	}
}

export function createSdkMcpConnector(options: SdkMcpConnectorOptions = {}): McpConnector {
	const limits: SdkMcpLimits = Object.freeze({ ...DEFAULT_SDK_MCP_LIMITS, ...options.limits });
	validateLimits(limits);
	return {
		async connect(definition, context) {
			const client = new Client(options.client ?? { name: "coda", version: "0.1.0" }, {
				capabilities: { elicitation: { form: {}, url: {} } },
				versionNegotiation: versionNegotiation(definition),
				supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
				inputRequired: { autoFulfill: true, maxRounds: limits.inputRequiredMaxRounds },
				listMaxPages: limits.listMaxPages,
				listChanged: {
					tools: {
						onChanged: (error) => {
							if (error) options.onError?.(definition.id, error);
							else context?.onToolsChanged?.();
						},
					},
				},
			});
			client.onerror = (error) => options.onError?.(definition.id, error);
			client.onclose = () => context?.onClose?.();
			const transport =
				definition.transport.kind === "http"
					? httpTransport(definition, options.fetch)
					: stdioTransport(definition, limits, options.onStderr);
			try {
				await client.connect(transport, {
					...(context?.signal ? { signal: context.signal } : {}),
					timeout: limits.connectTimeoutMs,
					maxTotalTimeout: limits.connectTimeoutMs,
				});
			} catch (error) {
				await client.close().catch(() => undefined);
				throw error;
			}
			const protocolEra = client.getProtocolEra();
			const protocolVersion = client.getNegotiatedProtocolVersion();
			if (!protocolEra || !protocolVersion) {
				await client.close().catch(() => undefined);
				throw new Error(`MCP Server "${definition.id}" did not negotiate a protocol version`);
			}
			const server = client.getServerVersion();
			return new SdkMcpConnection(
				client,
				{
					protocolEra,
					protocolVersion,
					...(server ? { server: { name: server.name, version: server.version } } : {}),
				},
				limits,
			);
		},
	};
}
