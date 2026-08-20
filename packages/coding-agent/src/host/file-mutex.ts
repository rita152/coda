import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { FileSystem, WritableFile } from "./file-system.ts";
import { isFileSystemError } from "./file-system.ts";

interface FileMutexRecord {
	readonly version: 1;
	readonly token: string;
	readonly pid: number;
	readonly acquiredAt: number;
}

const RETRY_DELAY_MS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;
const INCOMPLETE_RECORD_GRACE_MS = 30_000;
const RECOVERY_DIRECTORY_NAME = ".coda-file-mutex-recovery-v1";
const RECOVERY_NAMESPACE_DOMAIN = "coda-file-mutex-recovery-claim-v1";

type FileMutexOwnerInspection =
	| { readonly state: "missing" }
	| { readonly state: "busy" }
	| { readonly state: "recoverable"; readonly suffix: string };

function decodeRecord(source: string): FileMutexRecord {
	const value: unknown = JSON.parse(source);
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("token" in value) ||
		typeof value.token !== "string" ||
		!("pid" in value) ||
		!Number.isSafeInteger(value.pid) ||
		(value.pid as number) < 1 ||
		!("acquiredAt" in value) ||
		!Number.isFinite(value.acquiredAt)
	) {
		throw new Error("Invalid file mutex record");
	}
	return value as FileMutexRecord;
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isFileSystemError(error, "ESRCH");
	}
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function retire(fileSystem: FileSystem, path: string, suffix: string): Promise<boolean> {
	const retired = `${path}.stale-${suffix}-${randomUUID()}`;
	try {
		await fileSystem.rename(path, retired);
		await fileSystem.removeFile(retired).catch(() => undefined);
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

function recoveryClaimDirectory(path: string): string {
	return join(dirname(resolve(path)), RECOVERY_DIRECTORY_NAME);
}

function recoveryClaimPrefix(path: string): string {
	const digest = createHash("sha256")
		.update(RECOVERY_NAMESPACE_DOMAIN)
		.update("\0")
		.update(resolve(path))
		.digest("hex");
	return `${digest}.`;
}

function recoveryClaimPath(path: string, record: FileMutexRecord): string {
	return join(recoveryClaimDirectory(path), `${recoveryClaimPrefix(path)}${String(record.pid)}.${record.token}`);
}

async function resolveRecoveryClaimDirectory(
	fileSystem: FileSystem,
	path: string,
	create: boolean,
): Promise<string | undefined> {
	const directory = recoveryClaimDirectory(path);
	if (create) await fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
	const status = await fileSystem.lstat(directory).catch((error: unknown) => {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (!status) return undefined;
	if (status.kind !== "directory") {
		throw new Error(`File mutex recovery directory must be a regular directory: ${directory}`);
	}
	return directory;
}

async function inspectOwner(fileSystem: FileSystem, path: string): Promise<FileMutexOwnerInspection> {
	const status = await fileSystem.lstat(path).catch((error: unknown) => {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (!status) return { state: "missing" };
	if (status.kind !== "file") throw new Error(`File mutex path must be a regular file: ${path}`);
	let record: FileMutexRecord;
	try {
		record = decodeRecord(new TextDecoder().decode(await fileSystem.readFile(path)));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return { state: "missing" };
		if (Date.now() - status.modifiedAt >= INCOMPLETE_RECORD_GRACE_MS) {
			return { state: "recoverable", suffix: "incomplete" };
		}
		return { state: "busy" };
	}
	if (!processIsAlive(record.pid)) return { state: "recoverable", suffix: record.token };
	return { state: "busy" };
}

async function hasActiveRecoveryClaim(fileSystem: FileSystem, path: string): Promise<boolean> {
	const prefix = recoveryClaimPrefix(path);
	const directory = await resolveRecoveryClaimDirectory(fileSystem, path, false);
	if (!directory) return false;
	const entries = [...(await fileSystem.readDirectory(directory))].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	let active = false;
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix)) continue;
		const claimPath = join(directory, entry.name);
		const status = await fileSystem.lstat(claimPath).catch((error: unknown) => {
			if (isFileSystemError(error, "ENOENT")) return undefined;
			throw error;
		});
		if (!status) continue;
		if (status.kind !== "file") {
			throw new Error(`File mutex recovery claim must be a regular file: ${claimPath}`);
		}
		let record: FileMutexRecord;
		try {
			record = decodeRecord(new TextDecoder().decode(await fileSystem.readFile(claimPath)));
			if (recoveryClaimPath(path, record) !== claimPath) throw new Error("Invalid file mutex recovery claim");
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) continue;
			if (Date.now() - status.modifiedAt >= INCOMPLETE_RECORD_GRACE_MS) {
				await retire(fileSystem, claimPath, "incomplete-recovery");
				continue;
			}
			active = true;
			continue;
		}
		if (processIsAlive(record.pid)) {
			active = true;
			continue;
		}
		await retire(fileSystem, claimPath, "exited-recovery");
	}
	return active;
}

async function removeOwnedRecord(
	fileSystem: FileSystem,
	path: string,
	record: FileMutexRecord,
	options: { readonly allowMissing: boolean },
): Promise<boolean> {
	let current: FileMutexRecord;
	try {
		current = decodeRecord(new TextDecoder().decode(await fileSystem.readFile(path)));
	} catch (error) {
		if (options.allowMissing && isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
	if (current.token !== record.token || current.pid !== record.pid) {
		throw new Error(`File mutex ownership changed: ${path}`);
	}
	await fileSystem.removeFile(path);
	return true;
}

async function publishRecord(fileSystem: FileSystem, path: string, record: FileMutexRecord): Promise<void> {
	let handle: WritableFile | undefined;
	try {
		handle = await fileSystem.open(path, "wx", 0o600);
		await handle.write(`${JSON.stringify(record)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await removeOwnedRecord(fileSystem, path, record, { allowMissing: true }).catch(() => undefined);
		throw error;
	}
}

async function withRecoveryClaim<Result>(options: {
	readonly fileSystem: FileSystem;
	readonly path: string;
	readonly operation: () => Promise<Result>;
}): Promise<Result> {
	const record: FileMutexRecord = {
		version: 1,
		token: randomUUID(),
		pid: process.pid,
		acquiredAt: Date.now(),
	};
	const path = recoveryClaimPath(options.path, record);
	await resolveRecoveryClaimDirectory(options.fileSystem, options.path, true);
	await publishRecord(options.fileSystem, path, record);
	const settlement = await options.operation().then(
		(value) => ({ state: "fulfilled" as const, value }),
		(error: unknown) => ({ state: "rejected" as const, error }),
	);
	let releaseFailure: unknown;
	try {
		await removeOwnedRecord(options.fileSystem, path, record, { allowMissing: false });
	} catch (error) {
		releaseFailure = error;
	}
	if (settlement.state === "rejected") {
		if (releaseFailure) throw new AggregateError([settlement.error, releaseFailure], "File mutex recovery failed");
		throw settlement.error;
	}
	if (releaseFailure) throw releaseFailure;
	return settlement.value;
}

async function recoverOwner(fileSystem: FileSystem, path: string, signal?: AbortSignal): Promise<void> {
	await withRecoveryClaim({
		fileSystem,
		path,
		operation: async () => {
			signal?.throwIfAborted();
			const current = await inspectOwner(fileSystem, path);
			if (current.state === "recoverable") await retire(fileSystem, path, current.suffix);
		},
	});
}

export async function withFileMutex<Result>(options: {
	readonly fileSystem: FileSystem;
	readonly path: string;
	readonly operation: () => Promise<Result>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}): Promise<Result> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startedAt = Date.now();
	const token = randomUUID();
	const record: FileMutexRecord = { version: 1, token, pid: process.pid, acquiredAt: Date.now() };
	await options.fileSystem.makeDirectory(dirname(options.path), { recursive: true, mode: 0o700 });
	for (;;) {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		if (await hasActiveRecoveryClaim(options.fileSystem, options.path)) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring file mutex: ${options.path}`);
			}
			await wait(RETRY_DELAY_MS, options.signal);
			continue;
		}
		let handle: WritableFile;
		try {
			handle = await options.fileSystem.open(options.path, "wx", 0o600);
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) throw error;
			const current = await inspectOwner(options.fileSystem, options.path);
			if (current.state === "missing") continue;
			if (current.state === "recoverable") {
				await recoverOwner(options.fileSystem, options.path, options.signal);
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring file mutex: ${options.path}`);
			}
			await wait(RETRY_DELAY_MS, options.signal);
			continue;
		}
		try {
			await handle.write(`${JSON.stringify(record)}\n`);
			await handle.sync();
			await handle.close();
		} catch (error) {
			await handle.close().catch(() => undefined);
			await removeOwnedRecord(options.fileSystem, options.path, record, { allowMissing: true }).catch(
				() => undefined,
			);
			throw error;
		}
		let ownsPublishedRecord = false;
		try {
			const current = decodeRecord(new TextDecoder().decode(await options.fileSystem.readFile(options.path)));
			ownsPublishedRecord = current.token === token && current.pid === process.pid;
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
		const recoveryActive = await hasActiveRecoveryClaim(options.fileSystem, options.path);
		if (!ownsPublishedRecord || recoveryActive) {
			if (ownsPublishedRecord) {
				await removeOwnedRecord(options.fileSystem, options.path, record, { allowMissing: true });
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring file mutex: ${options.path}`);
			}
			await wait(RETRY_DELAY_MS, options.signal);
			continue;
		}
		break;
	}

	const settlement = await options.operation().then(
		(value) => ({ state: "fulfilled" as const, value }),
		(error: unknown) => ({ state: "rejected" as const, error }),
	);
	let releaseFailure: unknown;
	try {
		await removeOwnedRecord(options.fileSystem, options.path, record, { allowMissing: false });
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) releaseFailure = error;
	}
	if (settlement.state === "rejected") {
		if (releaseFailure) throw new AggregateError([settlement.error, releaseFailure], "File mutex operation failed");
		throw settlement.error;
	}
	if (releaseFailure) throw releaseFailure;
	return settlement.value;
}
