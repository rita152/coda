/** Minimum host process facts needed by the Node Tool Adapter. */
export interface HostProcessRuntime {
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

export function hostProcessEnvironment(runtime: HostProcessRuntime): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(runtime.environment)) {
		if (value !== undefined) environment[name] = value;
	}
	environment.HOME ??= runtime.homeDirectory;
	return environment;
}
