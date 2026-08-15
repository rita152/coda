import { join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import type { DirectoryEntry, FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { SessionFormatVersion, SessionHeader } from "./records.ts";

export class SessionJournalAppender {
	#handle: WritableFile | undefined;

	constructor(handle: WritableFile) {
		this.#handle = handle;
	}

	async append(value: unknown): Promise<void> {
		if (!this.#handle) throw new Error("Session journal appender is closed");
		await this.#handle.write(`${JSON.stringify(value)}\n`);
		await this.#handle.sync();
	}

	async close(): Promise<void> {
		const handle = this.#handle;
		this.#handle = undefined;
		await handle?.close();
	}
}

/** Owns physical journal IO, permissions, and atomic migration installation. */
export class SessionJournalStore {
	readonly #fileSystem: FileSystem;
	readonly #idGenerator: IdGenerator;

	constructor(options: { readonly fileSystem: FileSystem; readonly idGenerator: IdGenerator }) {
		this.#fileSystem = options.fileSystem;
		this.#idGenerator = options.idGenerator;
	}

	async prepareWorkspaceDirectory(homeDirectory: string, directory: string): Promise<void> {
		await this.#fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
		await this.#fileSystem.setMode(join(homeDirectory, ".coda"), 0o700);
		await this.#fileSystem.setMode(join(homeDirectory, ".coda", "sessions"), 0o700);
		await this.#fileSystem.setMode(directory, 0o700);
	}

	async readDirectory(directory: string): Promise<readonly DirectoryEntry[]> {
		return this.#fileSystem.readDirectory(directory);
	}

	async readText(path: string): Promise<string> {
		let bytes: Uint8Array;
		try {
			bytes = await this.#fileSystem.readFile(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) throw new Error(`Session not found: ${path}`);
			throw error;
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Session journal is not valid UTF-8");
		}
	}

	async create(path: string, header: SessionHeader): Promise<void> {
		await this.#writeNew(path, `${JSON.stringify(header)}\n`);
		await this.#fileSystem.setMode(path, 0o600);
	}

	async openAppender(path: string): Promise<SessionJournalAppender> {
		return new SessionJournalAppender(await this.#fileSystem.open(path, "a", 0o600));
	}

	async installMigration(input: {
		readonly path: string;
		readonly sourceText: string;
		readonly migratedText: string;
		readonly fromVersion: SessionFormatVersion;
		readonly validate: (text: string, path: string) => void;
	}): Promise<string> {
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const temporaryPath = `${input.path}.migrate-${token}.tmp`;
		const backupPath = `${input.path}.v${input.fromVersion}.backup`;
		let temporaryHandle: WritableFile | undefined;
		let installed = false;
		try {
			temporaryHandle = await this.#fileSystem.open(temporaryPath, "wx", 0o600);
			await temporaryHandle.write(input.migratedText);
			await temporaryHandle.sync();
			await temporaryHandle.close();
			temporaryHandle = undefined;
			input.validate(await this.#readExistingText(temporaryPath), temporaryPath);

			if (await this.#exists(backupPath)) {
				if ((await this.#readExistingText(backupPath)) !== input.sourceText) {
					throw new Error(`Existing Session v${input.fromVersion} backup does not match the journal`);
				}
			} else {
				await this.#writeNew(backupPath, input.sourceText);
				await this.#fileSystem.setMode(backupPath, 0o600);
			}

			await this.#fileSystem.rename(temporaryPath, input.path);
			await this.#fileSystem.setMode(input.path, 0o600);
			installed = true;
			return backupPath;
		} finally {
			await temporaryHandle?.close().catch(() => undefined);
			if (!installed) await this.#removeIfPresent(temporaryPath);
		}
	}

	async #writeNew(path: string, value: string): Promise<void> {
		const handle = await this.#fileSystem.open(path, "wx", 0o600);
		try {
			await handle.write(value);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async #readExistingText(path: string): Promise<string> {
		return new TextDecoder("utf-8", { fatal: true }).decode(await this.#fileSystem.readFile(path));
	}

	async #exists(path: string): Promise<boolean> {
		try {
			await this.#fileSystem.stat(path);
			return true;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #removeIfPresent(path: string): Promise<void> {
		try {
			await this.#fileSystem.removeFile(path);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
	}
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!safe) throw new Error("IdGenerator returned an invalid Session journal identity");
	return safe;
}
