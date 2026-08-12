import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunResult } from "../host/process-runner.ts";
import type { PermissionAuditSink } from "../permissions/audit.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";

export interface SearchExecutableRuntime {
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? (error as Error & { readonly code?: string }).code : undefined;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function existingCanonicalRoots(fileSystem: FileSystem, roots: readonly string[]): Promise<readonly string[]> {
	const canonical: string[] = [];
	for (const root of roots) {
		if (!isAbsolute(root)) continue;
		try {
			canonical.push(await fileSystem.realpath(root));
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	return Object.freeze([...new Set(canonical)]);
}

async function resolveSearchExecutable(options: {
	readonly name: "fd" | "rg";
	readonly path: string | undefined;
	readonly workspaceRoot: string;
	readonly writableRoots: readonly string[] | "full-disk";
	readonly temporaryDirectory: string | undefined;
	readonly fileSystem: FileSystem;
}): Promise<string | undefined> {
	const excludedRoots = await existingCanonicalRoots(options.fileSystem, [
		options.workspaceRoot,
		tmpdir(),
		"/tmp",
		...(options.temporaryDirectory ? [options.temporaryDirectory] : []),
		...(options.writableRoots === "full-disk" ? [] : options.writableRoots),
	]);
	for (const directory of (options.path ?? "").split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		let candidate: string;
		try {
			candidate = await options.fileSystem.realpath(join(directory, options.name));
			const status = await options.fileSystem.stat(candidate);
			if (status.kind !== "file" || (status.mode & 0o111) === 0) continue;
		} catch (error) {
			if (["EACCES", "ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) continue;
			throw error;
		}
		if (excludedRoots.some((root) => isContained(root, candidate))) continue;
		return candidate;
	}
	return undefined;
}

export async function runOptionalSearchExecutable(options: {
	readonly executable: "fd" | "rg";
	readonly args: readonly string[];
	readonly workspaceRoot: string;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
	readonly runtime: SearchExecutableRuntime;
	readonly context: Pick<ToolExecutionContext, "invocationId" | "signal">;
	readonly onAudit?: PermissionAuditSink;
}): Promise<ProcessRunResult | undefined> {
	const temporaryDirectory = join(options.runtime.homeDirectory, ".coda", "tmp");
	await options.fileSystem.makeDirectory(temporaryDirectory, { recursive: true, mode: 0o700 });
	await options.fileSystem.setMode(temporaryDirectory, 0o700);
	const safeInvocationId = options.context.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
	const path = join(temporaryDirectory, `${options.executable}-${safeInvocationId}.log`);
	const environment: Record<string, string> = { LC_ALL: "C" };
	if (options.runtime.environment.PATH) environment.PATH = options.runtime.environment.PATH;
	try {
		const readAccessPolicy = options.permissions.readAccessPolicyFor(options.context.invocationId);
		if (!readAccessPolicy) throw new Error("Search helper was not authorized by the Permission Engine");
		const policy = readAccessPolicy.sandboxPolicy;
		const executable = await resolveSearchExecutable({
			name: options.executable,
			path: options.runtime.environment.PATH,
			workspaceRoot: options.workspaceRoot,
			writableRoots: policy.writableRoots,
			temporaryDirectory: options.runtime.environment.TMPDIR,
			fileSystem: options.fileSystem,
		});
		if (!executable) return undefined;
		const result = await options.processRunner.run(
			{
				executable,
				args: options.args,
				cwd: options.workspaceRoot,
				environment,
				signal: options.context.signal,
				timeoutMs: 30_000,
				maxOutputBytes: 512 * 1024,
				maxOutputLines: 4_000,
				overflowPath: path,
			},
			{
				readAccessPolicy,
				auditContext: { invocationId: options.context.invocationId, toolName: options.executable },
				audit: options.onAudit,
			},
		);
		if (result.exitCode !== 0 && /(?:execvp\(\)|exec):?.*(?:no such file|not found)/iu.test(result.stderr)) {
			return undefined;
		}
		return result;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}
