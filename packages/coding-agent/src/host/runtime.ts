/** Minimum host process facts needed by the Node Tool Adapter. */
export interface HostProcessRuntime {
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}
