import { join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner, ProcessRunResult } from "../host/process-runner.ts";

export interface SearchExecutableRuntime {
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? (error as Error & { readonly code?: string }).code : undefined;
}

export async function runOptionalSearchExecutable(options: {
	readonly executable: "fd" | "rg";
	readonly args: readonly string[];
	readonly workspaceRoot: string;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly runtime: SearchExecutableRuntime;
	readonly context: Pick<ToolExecutionContext, "invocationId" | "signal">;
}): Promise<ProcessRunResult | undefined> {
	const temporaryDirectory = join(options.runtime.homeDirectory, ".coda", "tmp");
	await options.fileSystem.makeDirectory(temporaryDirectory, { recursive: true, mode: 0o700 });
	await options.fileSystem.setMode(temporaryDirectory, 0o700);
	const safeInvocationId = options.context.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
	const path = join(temporaryDirectory, `${options.executable}-${safeInvocationId}.log`);
	const environment: Record<string, string> = { LC_ALL: "C" };
	if (options.runtime.environment.PATH) environment.PATH = options.runtime.environment.PATH;
	try {
		return await options.processRunner.run({
			executable: options.executable,
			args: options.args,
			cwd: options.workspaceRoot,
			environment,
			signal: options.context.signal,
			timeoutMs: 30_000,
			maxOutputBytes: 512 * 1024,
			maxOutputLines: 4_000,
			overflowPath: path,
		});
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}
