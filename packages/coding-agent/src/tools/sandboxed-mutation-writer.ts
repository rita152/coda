import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import { execute } from "@coda/sandbox";
import { type PermissionAuditSink, permissionPolicyAuditSnapshot } from "../permissions/audit.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";

export interface AtomicMutationRequest {
	readonly target: string;
	readonly data: Uint8Array;
	readonly expectedExists: boolean;
	readonly expectedSha256?: string;
}

export interface AtomicMutationResult {
	readonly created: boolean;
	readonly previousSize: number;
	readonly size: number;
}

export interface AtomicMutationWriter {
	write(request: AtomicMutationRequest, context: ToolExecutionContext): Promise<AtomicMutationResult>;
}

interface MutationWorkerResponse extends AtomicMutationResult {
	readonly version: 1;
}

// This is deliberately an inline, immutable program rather than a Workspace-loaded helper. A model
// that can write dependency files must not be able to replace the reference monitor used for writes.
const MUTATION_WORKER_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validate(request) {
  if (!request || request.version !== 1 || request.operation !== 'atomic-write') throw new Error('invalid mutation protocol');
  if (typeof request.target !== 'string' || !isAbsolute(request.target) || normalize(request.target) !== request.target || request.target.includes('\0')) {
    throw new Error('target must be a canonical absolute path');
  }
  if (typeof request.invocation !== 'string' || !/^[A-Za-z0-9_-]+$/.test(request.invocation)) throw new Error('invalid invocation identity');
  if (typeof request.expectedExists !== 'boolean') throw new Error('invalid expectedExists');
  if (typeof request.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data)) {
    throw new Error('invalid base64 mutation payload');
  }
  if (request.expectedSha256 !== undefined && (typeof request.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedSha256))) {
    throw new Error('invalid expected content digest');
  }
  if (!request.parent || typeof request.parent.path !== 'string' || !request.parent.existing ||
      typeof request.parent.existing.path !== 'string' || typeof request.parent.existing.device !== 'string' ||
      typeof request.parent.existing.inode !== 'string') {
    throw new Error('invalid parent identity');
  }
}

function isContained(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..' + sep) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

async function ensureTargetParent(request, targetParent) {
  const existing = request.parent.existing;
  if (request.parent.path !== targetParent || !isContained(existing.path, targetParent)) {
    throw new Error('invalid target parent');
  }
  if (await realpath(existing.path) !== existing.path) throw new Error('target parent ancestor changed before mutation');
  const ancestor = await stat(existing.path, { bigint: true });
  if (!ancestor.isDirectory() || String(ancestor.dev) !== existing.device || String(ancestor.ino) !== existing.inode) {
    throw new Error('target parent ancestor identity changed before mutation');
  }
  const suffix = relative(existing.path, targetParent);
  let current = existing.path;
  for (const segment of suffix === '' ? [] : suffix.split(sep)) {
    current = join(current, segment);
    if (!(await optionalLstat(current))) {
      try { await mkdir(current, { mode: 0o755 }); }
      catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
    }
    const directory = await lstat(current, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error('target parent traverses a non-canonical directory');
    }
  }
}

async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  validate(request);
  const targetParent = dirname(request.target);
  await ensureTargetParent(request, targetParent);
  const data = Buffer.from(request.data, 'base64');
  const before = await optionalLstat(request.target);
  if (Boolean(before) !== request.expectedExists) throw new Error('target existence changed before mutation');
  if (before && !before.isFile()) throw new Error('target is not a regular file');
  if (request.expectedSha256 !== undefined && digest(await readFile(request.target)) !== request.expectedSha256) {
    throw new Error('target content changed before mutation');
  }
  const previousSize = before ? Number(before.size) : 0;
  const mode = before ? Number(before.mode & 0o7777n) : 0o644;
  const temporary = join(dirname(request.target), '.' + basename(request.target) + '.coda-' + request.invocation + '.tmp');
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    const current = await optionalLstat(request.target);
    if (Boolean(current) !== request.expectedExists) throw new Error('target existence changed during mutation');
    if (before && (!current || current.dev !== before.dev || current.ino !== before.ino || !current.isFile())) {
      throw new Error('target identity changed during mutation');
    }
    if (request.expectedSha256 !== undefined && digest(await readFile(request.target)) !== request.expectedSha256) {
      throw new Error('target content changed during mutation');
    }
    await rename(temporary, request.target);
    committed = true;
    process.stdout.write(JSON.stringify({ version: 1, created: !before, previousSize, size: data.byteLength }));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!committed) await unlink(temporary).catch((error) => { if (!error || error.code !== 'ENOENT') throw error; });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write('coda-file-mutation: ' + message + '\n');
  process.exitCode = 1;
});
`;

function abortError(): Error {
	const error = new Error("File mutation was aborted");
	error.name = "AbortError";
	return error;
}

function parseResponse(stdout: string): MutationWorkerResponse {
	let candidate: unknown;
	try {
		candidate = JSON.parse(stdout);
	} catch {
		throw new Error("Sandboxed file mutation returned an invalid response");
	}
	if (
		!candidate ||
		typeof candidate !== "object" ||
		(candidate as { version?: unknown }).version !== 1 ||
		typeof (candidate as { created?: unknown }).created !== "boolean" ||
		!Number.isSafeInteger((candidate as { previousSize?: unknown }).previousSize) ||
		!Number.isSafeInteger((candidate as { size?: unknown }).size)
	) {
		throw new Error("Sandboxed file mutation returned an invalid response");
	}
	return candidate as MutationWorkerResponse;
}

async function existingParentIdentity(parentPath: string): Promise<{
	readonly path: string;
	readonly device: string;
	readonly inode: string;
}> {
	let candidate = parentPath;
	for (;;) {
		try {
			const canonical = await realpath(candidate);
			if (canonical !== candidate) throw new Error("Sandboxed mutation parent must remain canonical");
			const status = await stat(candidate, { bigint: true });
			if (!status.isDirectory()) throw new Error("Sandboxed mutation parent ancestor is not a directory");
			return { path: candidate, device: String(status.dev), inode: String(status.ino) };
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw new Error(`Sandboxed mutation parent has no existing ancestor: ${parentPath}`);
			candidate = parent;
		}
	}
}

export function createSandboxedMutationWriter(options: {
	readonly workspace: Pick<Workspace, "root">;
	readonly permissions: Pick<PermissionEngine, "readAccessPolicyFor">;
	readonly onAudit?: PermissionAuditSink;
	/** Deterministic race-test seam; production composition leaves this undefined. */
	readonly beforeLaunch?: () => Promise<void> | void;
}): AtomicMutationWriter {
	return {
		write: async (request, context) => {
			if (!isAbsolute(request.target) || normalize(request.target) !== request.target) {
				throw new Error("Sandboxed mutation target must be a canonical absolute path");
			}
			const readAccessPolicy = options.permissions.readAccessPolicyFor(context.invocationId);
			if (!readAccessPolicy) throw new Error("File mutation was not authorized by the Permission Engine");
			const policy = readAccessPolicy.sandboxPolicy;
			const invocation = context.invocationId.replace(/[^A-Za-z0-9_-]/gu, "-");
			const parentPath = dirname(request.target);
			const existingParent = await existingParentIdentity(parentPath);
			await options.beforeLaunch?.();
			let result: Awaited<ReturnType<typeof execute>>;
			try {
				result = await execute({
					command: [process.execPath, "--input-type=module", "--eval", MUTATION_WORKER_SOURCE],
					cwd: options.workspace.root,
					environment: {},
					policy,
					timeoutMs: 30_000,
					signal: context.signal,
					maxOutputBytes: 64 * 1024,
					stdin: JSON.stringify({
						version: 1,
						operation: "atomic-write",
						target: request.target,
						invocation,
						expectedExists: request.expectedExists,
						expectedSha256: request.expectedSha256,
						parent: {
							path: parentPath,
							existing: existingParent,
						},
						data: Buffer.from(request.data).toString("base64"),
					}),
				});
			} catch (error) {
				await options.onAudit?.({
					type: "sandbox_execution",
					invocationId: context.invocationId,
					toolName: "file-mutation",
					policy: permissionPolicyAuditSnapshot(policy),
					outcome: "launch-failed",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			await options.onAudit?.({
				type: "sandbox_execution",
				invocationId: context.invocationId,
				toolName: "file-mutation",
				policy: permissionPolicyAuditSnapshot(policy),
				backend: result.backend,
				outcome:
					result.status === "denied"
						? "sandbox-denial"
						: result.status === "timed-out"
							? "timed-out"
							: result.status === "cancelled"
								? "cancelled"
								: result.exitCode === 0
									? "success"
									: "normal-failure",
				exitCode: result.exitCode,
				signal: result.signal,
				...(result.status === "denied" ? { denial: result.denial } : {}),
			});
			if (result.status === "cancelled") throw abortError();
			if (result.status === "timed-out") throw new Error("Sandboxed file mutation timed out");
			if (result.status === "denied") {
				const path = result.denial.kind === "filesystem" ? result.denial.path : undefined;
				throw new Error(`Sandbox denied file mutation: ${result.denial.reason}${path ? ` (${path})` : ""}`);
			}
			if (result.exitCode !== 0) {
				throw new Error(result.stderr.trim() || `Sandboxed file mutation exited with ${result.exitCode}`);
			}
			return parseResponse(result.stdout);
		},
	};
}
