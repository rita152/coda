import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { type ProcessConfinementConfig, type ProcessConfinementEngine, ProcessConfinementError } from "./types.ts";

function definedEnvironment(
	base: Readonly<Record<string, string>>,
	overlay: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries({ ...base, ...overlay }).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
	);
}

export function createAnthropicSandboxEngine(): ProcessConfinementEngine {
	return {
		async initialize(config: ProcessConfinementConfig) {
			await SandboxManager.initialize({
				network: {
					allowedDomains: [...(config.allowedDomains ?? [])],
					deniedDomains: [...(config.deniedDomains ?? [])],
				},
				filesystem: {
					denyRead: [...(config.denyRead ?? [])],
					allowWrite: [...(config.allowWrite ?? [config.workspace, "/tmp"])],
					denyWrite: [...(config.denyWrite ?? [])],
				},
			});
		},
		async wrapScript(request) {
			const wrapped = await SandboxManager.wrapWithSandboxArgv(
				request.command,
				request.shell,
				undefined,
				undefined,
				request.cwd,
				{
					...(request.commandId ? { commandId: request.commandId } : {}),
					commandText: request.command,
				},
			);
			const executable = wrapped.argv[0];
			if (!executable) {
				throw new ProcessConfinementError("wrap-failed", "Sandbox Runtime returned an empty argv");
			}
			SandboxManager.cleanupAfterCommand();
			return Object.freeze({
				executable,
				args: Object.freeze(wrapped.argv.slice(1)),
				environment: definedEnvironment(request.environment, wrapped.env),
			});
		},
		async close() {
			await SandboxManager.reset();
		},
	};
}
