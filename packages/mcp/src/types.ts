export type McpProtocolPolicy = "2026-07-28" | "auto" | "legacy";

export interface McpStdioTransportDefinition {
	readonly kind: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string>>;
}

export interface McpHttpTransportDefinition {
	readonly kind: "http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly bearerToken?: () => Promise<string | undefined>;
}

export interface McpToolFilter {
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
}

export interface McpServerDefinition {
	readonly id: string;
	readonly protocol: McpProtocolPolicy;
	readonly transport: McpStdioTransportDefinition | McpHttpTransportDefinition;
	readonly enabled?: boolean;
	readonly tools?: McpToolFilter;
}

export interface McpImplementationIdentity {
	readonly name: string;
	readonly version: string;
}

export interface McpConnectionInfo {
	readonly protocolEra: "modern" | "legacy";
	readonly protocolVersion: string;
	readonly server?: McpImplementationIdentity;
}

export type McpJsonSchema = Readonly<Record<string, unknown>>;

export interface McpRemoteTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: McpJsonSchema;
	readonly outputSchema?: McpJsonSchema;
	readonly annotations?: Readonly<Record<string, unknown>>;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpAnnotations {
	readonly audience?: readonly ("user" | "assistant")[];
	readonly priority?: number;
	readonly lastModified?: string;
}

export interface McpContentMetadata {
	readonly annotations?: McpAnnotations;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpIcon {
	readonly src: string;
	readonly mimeType?: string;
	readonly sizes?: readonly string[];
	readonly theme?: "light" | "dark";
}

export interface McpTextContent extends McpContentMetadata {
	readonly type: "text";
	readonly text: string;
}

export interface McpImageContent extends McpContentMetadata {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface McpAudioContent extends McpContentMetadata {
	readonly type: "audio";
	readonly data: string;
	readonly mimeType: string;
}

export interface McpResourceLinkContent extends McpContentMetadata {
	readonly type: "resource_link";
	readonly uri: string;
	readonly name?: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
	readonly icons?: readonly McpIcon[];
}

export interface McpEmbeddedTextResource {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpEmbeddedBlobResource {
	readonly uri: string;
	readonly mimeType?: string;
	readonly blob: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpEmbeddedResourceContent extends McpContentMetadata {
	readonly type: "resource";
	readonly resource: McpEmbeddedTextResource | McpEmbeddedBlobResource;
}

export type McpToolContent =
	| McpTextContent
	| McpImageContent
	| McpAudioContent
	| McpResourceLinkContent
	| McpEmbeddedResourceContent;

export interface McpToolResult {
	readonly isError: boolean;
	readonly content: readonly McpToolContent[];
	readonly structuredContent?: unknown;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpProgress {
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

export type McpElicitationResult =
	| {
			readonly action: "accept";
			readonly content?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
	  }
	| { readonly action: "decline" | "cancel" };

export type McpElicitationRequest =
	| {
			readonly mode: "form";
			readonly message: string;
			readonly requestedSchema: McpJsonSchema;
	  }
	| {
			readonly mode: "url";
			readonly message: string;
			readonly url: string;
	  };

export interface McpCallContext {
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: McpProgress) => void;
	readonly elicit?: (request: McpElicitationRequest) => Promise<McpElicitationResult>;
}

export interface McpConnection {
	readonly info: McpConnectionInfo;
	listTools(context?: { readonly signal?: AbortSignal }): Promise<readonly McpRemoteTool[]>;
	callTool(
		request: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
		context?: McpCallContext,
	): Promise<McpToolResult>;
	close(): Promise<void>;
}

export interface McpConnector {
	connect(
		definition: McpServerDefinition,
		context?: {
			readonly signal?: AbortSignal;
			readonly onToolsChanged?: () => void;
			readonly onClose?: (error?: Error) => void;
		},
	): Promise<McpConnection>;
}

export interface McpToolDescriptor {
	readonly id: string;
	readonly serverId: string;
	readonly remoteName: string;
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: McpJsonSchema;
	readonly outputSchema?: McpJsonSchema;
	readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpServerSnapshot {
	readonly id: string;
	readonly status: "ready" | "degraded" | "disabled";
	readonly protocolEra?: "modern" | "legacy";
	readonly protocolVersion?: string;
	readonly server?: McpImplementationIdentity;
	readonly toolCount: number;
	readonly error?: string;
}

export interface McpDiagnostic {
	readonly serverId: string;
	readonly code: string;
	readonly message: string;
	readonly toolName?: string;
}

export interface McpHostSnapshot {
	readonly revision: number;
	readonly servers: readonly McpServerSnapshot[];
	readonly tools: readonly McpToolDescriptor[];
	readonly diagnostics: readonly McpDiagnostic[];
}

export interface McpToolSnapshot {
	readonly revision: number;
	readonly servers: readonly McpServerSnapshot[];
	readonly tools: readonly McpToolDescriptor[];
	callTool(request: McpToolCallRequest): Promise<McpToolResult>;
}

export interface McpToolCallRequest extends McpCallContext {
	readonly toolId: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export interface McpHost {
	reload(
		definitions: readonly McpServerDefinition[],
		context?: { readonly signal?: AbortSignal },
	): Promise<McpHostSnapshot>;
	refresh(context?: { readonly signal?: AbortSignal }): Promise<McpHostSnapshot>;
	reconnect(serverId: string, context?: { readonly signal?: AbortSignal }): Promise<McpHostSnapshot>;
	snapshot(): McpHostSnapshot;
	freezeTools(): McpToolSnapshot;
	onDidChange(listener: (snapshot: McpHostSnapshot) => void): () => void;
	callTool(request: McpToolCallRequest): Promise<McpToolResult>;
	close(): Promise<void>;
}
