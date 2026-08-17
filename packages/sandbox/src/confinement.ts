import { isAbsolute, join } from "node:path";
import {
	type ProcessConfinement,
	type ProcessConfinementConfig,
	type ProcessConfinementEngine,
	ProcessConfinementError,
	SANDBOX_MODES,
	type SandboxMode,
} from "./types.ts";

function requireAbsolute(path: string, label: string): string {
	if (!isAbsolute(path)) {
		throw new ProcessConfinementError("initialize-failed", `${label} must be an absolute path`);
	}
	return path;
}

export function isSandboxMode(value: string): value is SandboxMode {
	return (SANDBOX_MODES as readonly string[]).includes(value);
}

export function processConfinementActive(mode: SandboxMode): boolean {
	return mode !== "danger-full-access";
}

export function filesystemAccessForSandboxMode(mode: SandboxMode): "restricted" | "unrestricted" {
	return mode === "danger-full-access" ? "unrestricted" : "restricted";
}

export function writableRootsForSandboxMode(workspace: string, mode: SandboxMode): readonly string[] {
	return mode === "workspace-write" ? [workspace, "/tmp"] : [];
}

export function denyWriteForSandboxMode(workspace: string, mode: SandboxMode): readonly string[] {
	if (mode !== "workspace-write") return [];
	return [join(workspace, ".git"), join(workspace, ".agents"), join(workspace, ".coda")];
}

export function resolvedConfinementConfig(config: ProcessConfinementConfig): ProcessConfinementConfig {
	const workspace = requireAbsolute(config.workspace, "Process Confinement workspace");
	const mode = config.mode ?? "workspace-write";
	if (mode === "danger-full-access") {
		throw new ProcessConfinementError("initialize-failed", "danger-full-access does not use Process Confinement");
	}
	const allowWrite = config.allowWrite ?? (mode === "read-only" ? [] : [workspace, "/tmp"]);
	const denyWrite = config.denyWrite ?? denyWriteForSandboxMode(workspace, mode);
	return Object.freeze({
		workspace,
		mode,
		allowWrite: Object.freeze(allowWrite.map((path) => requireAbsolute(path, "allowWrite"))),
		denyWrite: Object.freeze(denyWrite.map((path) => requireAbsolute(path, "denyWrite"))),
		denyRead: Object.freeze((config.denyRead ?? []).map((path) => requireAbsolute(path, "denyRead"))),
		allowedDomains: Object.freeze([...(config.allowedDomains ?? [])]),
		deniedDomains: Object.freeze([...(config.deniedDomains ?? [])]),
	});
}

export async function openProcessConfinement(options: {
	readonly config: ProcessConfinementConfig;
	readonly engine: ProcessConfinementEngine;
	readonly platform: NodeJS.Platform;
}): Promise<ProcessConfinement> {
	if (options.platform === "win32") {
		throw new ProcessConfinementError("unsupported-platform", "Process Confinement is not supported on Windows");
	}
	const config = resolvedConfinementConfig(options.config);
	try {
		await options.engine.initialize(config);
	} catch (error) {
		if (error instanceof ProcessConfinementError) throw error;
		throw new ProcessConfinementError("initialize-failed", error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	}
	let closed = false;
	return {
		async wrapScript(request) {
			if (closed) throw new ProcessConfinementError("wrap-failed", "Process Confinement is closed");
			try {
				return await options.engine.wrapScript(request);
			} catch (error) {
				if (error instanceof ProcessConfinementError) throw error;
				throw new ProcessConfinementError("wrap-failed", error instanceof Error ? error.message : String(error), {
					cause: error,
				});
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await options.engine.close();
		},
	};
}
