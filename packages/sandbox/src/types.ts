export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type ProcessConfinementErrorCode = "unsupported-platform" | "initialize-failed" | "wrap-failed";

export class ProcessConfinementError extends Error {
	readonly code: ProcessConfinementErrorCode;

	constructor(code: ProcessConfinementErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProcessConfinementError";
		this.code = code;
	}
}

export interface ProcessConfinementConfig {
	readonly workspace: string;
	readonly mode?: SandboxMode;
	readonly allowWrite?: readonly string[];
	readonly denyWrite?: readonly string[];
	readonly denyRead?: readonly string[];
	readonly allowedDomains?: readonly string[];
	readonly deniedDomains?: readonly string[];
	readonly tmpdir?: string;
}

export interface WrapScriptRequest {
	readonly command: string;
	readonly shell: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly commandId?: string;
}

export interface WrappedProcessSpawn {
	readonly executable: string;
	readonly args: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
}

export interface ProcessConfinement {
	wrapScript(request: WrapScriptRequest): Promise<WrappedProcessSpawn>;
	close(): Promise<void>;
}

export interface ProcessConfinementEngine {
	initialize(config: ProcessConfinementConfig): Promise<void>;
	wrapScript(request: WrapScriptRequest): Promise<WrappedProcessSpawn>;
	close(): Promise<void>;
}
