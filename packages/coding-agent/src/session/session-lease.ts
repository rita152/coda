import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { OpenSessionRequest, SessionId } from "./types.ts";

export type ProcessStatus = "alive" | "dead" | "unknown";

export interface SessionLockOwner {
	readonly token: string;
	readonly pid: number;
	readonly processStartedAt: number;
	readonly hostname: string;
}

export interface ProcessInspector {
	status(owner: Pick<SessionLockOwner, "pid" | "processStartedAt">): Promise<ProcessStatus>;
}

interface LockFile extends SessionLockOwner {
	readonly sessionId: string;
	readonly createdAt: number;
}

/** Represents one exclusive, ownership-checked lease on a Session journal. */
export class SessionLease {
	readonly #fileSystem: FileSystem;
	readonly #lockPath: string;
	readonly #sessionId: SessionId;
	readonly #owner: SessionLockOwner;
	readonly #processInspector: ProcessInspector;
	readonly #now: () => number;
	#held = false;

	constructor(options: {
		readonly fileSystem: FileSystem;
		readonly lockPath: string;
		readonly sessionId: SessionId;
		readonly owner: SessionLockOwner;
		readonly processInspector: ProcessInspector;
		readonly now: () => number;
	}) {
		this.#fileSystem = options.fileSystem;
		this.#lockPath = options.lockPath;
		this.#sessionId = options.sessionId;
		this.#owner = options.owner;
		this.#processInspector = options.processInspector;
		this.#now = options.now;
	}

	async acquire(request: Pick<OpenSessionRequest, "mode" | "forceUnlock">): Promise<void> {
		const lock: LockFile = {
			...this.#owner,
			sessionId: this.#sessionId,
			createdAt: this.#now(),
		};
		const create = async (): Promise<void> => {
			const handle = await this.#fileSystem.open(this.#lockPath, "wx", 0o600);
			this.#held = true;
			try {
				await handle.write(`${JSON.stringify(lock)}\n`);
				await handle.sync();
				await handle.close();
				await this.#fileSystem.setMode(this.#lockPath, 0o600);
			} catch (error) {
				await handle.close().catch(() => undefined);
				try {
					await this.#fileSystem.removeFile(this.#lockPath);
					this.#held = false;
				} catch {}
				throw error;
			}
		};
		try {
			await create();
			return;
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) throw error;
		}
		const existing = parseLock(new TextDecoder().decode(await this.#fileSystem.readFile(this.#lockPath)));
		const status = await this.#processInspector.status(existing);
		if (status !== "dead") throw new Error(`Session is locked by ${status} owner PID ${existing.pid}`);
		if (request.mode === "print" && !request.forceUnlock) {
			throw new Error("A dead Session lock requires --force-unlock in print mode");
		}
		await this.#fileSystem.rename(this.#lockPath, `${this.#lockPath}.stale-${this.#now()}`);
		await create();
	}

	async release(): Promise<void> {
		if (!this.#held) return;
		let text: string;
		try {
			text = new TextDecoder().decode(await this.#fileSystem.readFile(this.#lockPath));
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) {
				this.#held = false;
				return;
			}
			throw error;
		}
		const lock = parseLock(text);
		if (lock.token !== this.#owner.token) {
			throw new Error("Refusing to remove a Session lock owned by another process");
		}
		await this.#fileSystem.removeFile(this.#lockPath);
		this.#held = false;
	}
}

function parseLock(value: string): LockFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Session lock is corrupt; ownership is uncertain");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.token !== "string" ||
		typeof parsed.pid !== "number" ||
		typeof parsed.processStartedAt !== "number" ||
		typeof parsed.hostname !== "string" ||
		typeof parsed.sessionId !== "string" ||
		typeof parsed.createdAt !== "number"
	) {
		throw new Error("Session lock is invalid; ownership is uncertain");
	}
	return parsed as unknown as LockFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
