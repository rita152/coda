import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
	await options.fileSystem.makeDirectory(dirname(options.path), { recursive: true, mode: 0o700 });
	for (;;) {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		let handle: WritableFile;
		try {
			handle = await options.fileSystem.open(options.path, "wx", 0o600);
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) throw error;
			let record: FileMutexRecord | undefined;
			try {
				record = decodeRecord(new TextDecoder().decode(await options.fileSystem.readFile(options.path)));
			} catch (readError) {
				if (isFileSystemError(readError, "ENOENT")) continue;
				const status = await options.fileSystem.lstat(options.path).catch(() => undefined);
				if (status && Date.now() - status.modifiedAt >= INCOMPLETE_RECORD_GRACE_MS) {
					await retire(options.fileSystem, options.path, "incomplete");
					continue;
				}
			}
			if (record && !processIsAlive(record.pid)) {
				await retire(options.fileSystem, options.path, record.token);
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring file mutex: ${options.path}`);
			}
			await wait(RETRY_DELAY_MS, options.signal);
			continue;
		}
		const record: FileMutexRecord = { version: 1, token, pid: process.pid, acquiredAt: Date.now() };
		try {
			await handle.write(`${JSON.stringify(record)}\n`);
			await handle.close();
		} catch (error) {
			await handle.close().catch(() => undefined);
			await options.fileSystem.removeFile(options.path).catch(() => undefined);
			throw error;
		}
		break;
	}

	const settlement = await options.operation().then(
		(value) => ({ state: "fulfilled" as const, value }),
		(error: unknown) => ({ state: "rejected" as const, error }),
	);
	let releaseFailure: unknown;
	try {
		const current = decodeRecord(new TextDecoder().decode(await options.fileSystem.readFile(options.path)));
		if (current.token !== token) throw new Error(`File mutex ownership changed: ${options.path}`);
		await options.fileSystem.removeFile(options.path);
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
