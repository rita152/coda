import { dirname } from "node:path";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import { type FileSystem, isFileSystemError, type WritableFile } from "../host/file-system.ts";

type WorkJournal = NonNullable<OpenCodingAgentOptions["journal"]>;
type WorkJournalRecord = Parameters<WorkJournal["append"]>[0];
type WorkJournalRestore = Awaited<ReturnType<WorkJournal["load"]>>;

const RECORD_TYPES = new Set([
	"batch_accepted",
	"input_resources_settled",
	"item_transition",
	"worker_event",
	"item_result",
	"graph_result",
	"cancellation_requested",
	"publication",
	"ownership_released",
	"recovery_interrupted",
]);

interface JournalEnvelope {
	readonly version: 1;
	readonly sequence: number;
	readonly record: WorkJournalRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEnvelope(line: string, expectedSequence: number): JournalEnvelope {
	const value: unknown = JSON.parse(line);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.sequence !== expectedSequence ||
		!isRecord(value.record) ||
		typeof value.record.type !== "string" ||
		!RECORD_TYPES.has(value.record.type)
	) {
		throw new Error(`Invalid Work Journal record envelope at sequence ${expectedSequence}`);
	}
	return value as unknown as JournalEnvelope;
}

class FileWorkJournal implements WorkJournal {
	readonly #fileSystem: FileSystem;
	readonly #path: string;
	#loadOperation?: Promise<WorkJournalRestore>;
	#handle?: WritableFile;
	#sequence = 0;
	#tail: Promise<void> = Promise.resolve();
	#failure?: unknown;
	#closed = false;

	constructor(fileSystem: FileSystem, path: string) {
		if (path.length === 0) throw new Error("Work Journal path must not be empty");
		this.#fileSystem = fileSystem;
		this.#path = path;
	}

	load(): Promise<WorkJournalRestore> {
		if (this.#closed) return Promise.reject(new Error("Work Journal is closed"));
		if (!this.#loadOperation) this.#loadOperation = this.#load();
		return this.#loadOperation;
	}

	async append(record: WorkJournalRecord): Promise<void> {
		if (this.#closed) throw new Error("Work Journal is closed");
		await this.load();
		const durableRecord = structuredClone(record);
		await this.#enqueue(async () => {
			const sequence = this.#sequence + 1;
			const envelope: JournalEnvelope = { version: 1, sequence, record: durableRecord };
			const handle = await this.#fileHandle();
			await handle.write(`${JSON.stringify(envelope)}\n`);
			await handle.sync();
			this.#sequence = sequence;
		});
	}

	async flush(): Promise<void> {
		if (this.#closed) throw new Error("Work Journal is closed");
		await this.#tail;
		this.#assertHealthy();
		try {
			await this.#handle?.sync();
		} catch (error) {
			this.#poison(error);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		let failure = this.#failure;
		if (!failure) {
			try {
				await this.#handle?.sync();
			} catch (error) {
				this.#poison(error);
				failure = error;
			}
		}
		try {
			await this.#handle?.close();
		} catch (error) {
			if (!failure) failure = error;
		}
		this.#handle = undefined;
		if (failure) throw failure;
	}

	async #load(): Promise<WorkJournalRestore> {
		let source = "";
		try {
			source = new TextDecoder().decode(await this.#fileSystem.readFile(this.#path));
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
		const diagnostics: string[] = [];
		const lines = source.split("\n");
		const hasPartialTail = lines.at(-1)?.length !== 0;
		if (!hasPartialTail) lines.pop();
		const records: WorkJournalRecord[] = [];
		let repaired = false;
		for (const [index, line] of lines.entries()) {
			try {
				const envelope = decodeEnvelope(line, index + 1);
				records.push(envelope.record);
				this.#sequence = envelope.sequence;
			} catch (error) {
				if (hasPartialTail && index === lines.length - 1) {
					diagnostics.push(`Ignored incomplete Work Journal tail at sequence ${index + 1}`);
					repaired = true;
					break;
				}
				throw error;
			}
		}
		if (repaired) {
			const encoded = lines.slice(0, records.length).join("\n");
			await this.#replace(encoded.length > 0 ? `${encoded}\n` : "");
		}
		return { records: Object.freeze(records), diagnostics: Object.freeze(diagnostics) };
	}

	async #replace(value: string): Promise<void> {
		await this.#fileSystem.makeDirectory(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.repair-${process.pid}-${Date.now()}`;
		try {
			const handle = await this.#fileSystem.open(temporary, "wx");
			try {
				await handle.write(value);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#fileSystem.rename(temporary, this.#path);
		} catch (error) {
			await this.#fileSystem.removeFile(temporary).catch(() => undefined);
			throw error;
		}
	}

	async #fileHandle(): Promise<WritableFile> {
		if (this.#handle) return this.#handle;
		await this.#fileSystem.makeDirectory(dirname(this.#path), { recursive: true });
		this.#handle = await this.#fileSystem.open(this.#path, "a");
		return this.#handle;
	}

	#enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.#tail.then(async () => {
			this.#assertHealthy();
			try {
				await operation();
			} catch (error) {
				this.#poison(error);
				throw error;
			}
		});
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#assertHealthy(): void {
		if (this.#failure) throw this.#failure;
	}

	#poison(error: unknown): void {
		this.#failure ??= error;
	}
}

export function createFileWorkJournal(fileSystem: FileSystem, path: string): WorkJournal {
	return new FileWorkJournal(fileSystem, path);
}
