import { dirname } from "node:path";
import type { OpenCodingAgentOptions, WorkerFact } from "@coda/runtime";
import { type FileSystem, isFileSystemError, type WritableFile } from "../host/file-system.ts";

type WorkJournal = NonNullable<OpenCodingAgentOptions["journal"]>;
type WorkJournalRecord = Parameters<WorkJournal["append"]>[0];
type WorkJournalRestore = Awaited<ReturnType<WorkJournal["load"]>>;

const RECORD_TYPES = new Set([
	"batch_accepted",
	"input_resources_settled",
	"item_transition",
	"worker_fact",
	"item_result",
	"graph_result",
	"cancellation_requested",
	"publication",
	"ownership_released",
	"recovery_interrupted",
]);
const MAXIMUM_WORKER_FACT_ID_LENGTH = 256;
const MAXIMUM_DERIVED_WORKER_ID_LENGTH = 1_024;
const MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH = 128;

interface JournalEnvelope {
	readonly version: 2;
	readonly sequence: number;
	readonly record: WorkJournalRecord;
}

const WORKER_FACT_KEYS = {
	run_started: ["type", "runId", "timestamp"],
	attempt_started: ["type", "runId", "turnId", "attemptId", "messageId", "attempt", "timestamp"],
	attempt_settled: [
		"type",
		"runId",
		"turnId",
		"attemptId",
		"messageId",
		"attempt",
		"outcome",
		"discarded",
		"totalTokens",
		"timestamp",
	],
	tool_started: ["type", "runId", "turnId", "invocationId", "toolName", "replaySafety", "timestamp"],
	tool_settled: ["type", "runId", "turnId", "invocationId", "settlement", "outcome", "timestamp"],
	turn_settled: ["type", "runId", "turnId", "outcome", "timestamp"],
	budget_exhausted: ["type", "runId", "exhaustion", "timestamp"],
	run_settled: ["type", "runId", "outcome", "failureKind", "timestamp"],
} as const satisfies Record<WorkerFact["type"], readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidWorkerFact(type: string, diagnostic: string): never {
	throw new Error(`Invalid encoded Worker Fact ${type}: ${diagnostic}`);
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	type: string,
	optional: readonly string[] = [],
): void {
	const admitted = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!admitted.has(key)) invalidWorkerFact(type, `unexpected field ${key}`);
	}
	const optionalKeys = new Set(optional);
	for (const key of allowed) {
		if (!optionalKeys.has(key) && !(key in value)) invalidWorkerFact(type, `missing field ${key}`);
	}
}

function assertBoundedIdentity(
	value: unknown,
	field: string,
	type: string,
	maximum = MAXIMUM_WORKER_FACT_ID_LENGTH,
): void {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		invalidWorkerFact(type, `${field} must be a non-empty string of at most ${maximum} characters`);
	}
}

function assertSafeCounter(value: unknown, field: string, type: string, minimum = 0): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		invalidWorkerFact(type, `${field} must be a safe integer greater than or equal to ${minimum}`);
	}
}

function assertOneOf(value: unknown, field: string, type: string, admitted: readonly string[]): void {
	if (typeof value !== "string" || !admitted.includes(value)) {
		invalidWorkerFact(type, `${field} has an unsupported value`);
	}
}

function assertEncodedExhaustion(value: unknown, type: string): void {
	if (!isRecord(value)) invalidWorkerFact(type, "exhaustion must be an object");
	assertExactKeys(value, ["limit", "maximum", "observed"], type);
	assertOneOf(value.limit, "exhaustion.limit", type, [
		"turns",
		"model_attempts",
		"tool_invocations",
		"elapsed_ms",
		"total_tokens",
		"total_cost_usd",
		"consecutive_equivalent_tool_batches",
	]);
	if (typeof value.maximum !== "number" || !Number.isFinite(value.maximum) || value.maximum < 0) {
		invalidWorkerFact(type, "exhaustion.maximum must be a non-negative finite number");
	}
	if (typeof value.observed !== "number" || !Number.isFinite(value.observed) || value.observed < 0) {
		invalidWorkerFact(type, "exhaustion.observed must be a non-negative finite number");
	}
}

function assertEncodedWorkerFact(value: unknown): asserts value is WorkerFact {
	if (!isRecord(value) || typeof value.type !== "string" || !(value.type in WORKER_FACT_KEYS)) {
		invalidWorkerFact("unknown", "unsupported fact type");
	}
	const type = value.type as WorkerFact["type"];
	assertExactKeys(value, WORKER_FACT_KEYS[type], type, type === "run_settled" ? ["failureKind"] : []);
	assertBoundedIdentity(value.runId, "runId", type);
	if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
		invalidWorkerFact(type, "timestamp must be a non-negative safe integer");
	}
	switch (type) {
		case "run_started":
			return;
		case "attempt_started":
			assertBoundedIdentity(value.turnId, "turnId", type);
			assertBoundedIdentity(value.attemptId, "attemptId", type);
			assertBoundedIdentity(value.messageId, "messageId", type);
			assertSafeCounter(value.attempt, "attempt", type, 1);
			return;
		case "attempt_settled":
			assertBoundedIdentity(value.turnId, "turnId", type);
			assertBoundedIdentity(value.attemptId, "attemptId", type);
			assertBoundedIdentity(value.messageId, "messageId", type);
			assertSafeCounter(value.attempt, "attempt", type, 1);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			if (typeof value.discarded !== "boolean") invalidWorkerFact(type, "discarded must be boolean");
			assertSafeCounter(value.totalTokens, "totalTokens", type);
			return;
		case "tool_started":
			assertBoundedIdentity(value.turnId, "turnId", type);
			assertBoundedIdentity(value.invocationId, "invocationId", type);
			if (
				typeof value.toolName !== "string" ||
				value.toolName.length === 0 ||
				value.toolName.length > MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH
			) {
				invalidWorkerFact(type, `toolName must be 1-${MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH} characters`);
			}
			assertOneOf(value.replaySafety, "replaySafety", type, ["never", "safe"]);
			return;
		case "tool_settled":
			assertBoundedIdentity(value.turnId, "turnId", type);
			assertBoundedIdentity(value.invocationId, "invocationId", type);
			assertOneOf(value.settlement, "settlement", type, ["returned", "threw", "aborted"]);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			return;
		case "turn_settled":
			assertBoundedIdentity(value.turnId, "turnId", type);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			return;
		case "budget_exhausted":
			assertEncodedExhaustion(value.exhaustion, type);
			return;
		case "run_settled":
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			if (value.failureKind !== undefined) {
				assertOneOf(value.failureKind, "failureKind", type, ["model", "tool", "runtime", "listener", "budget"]);
			}
			return;
	}
	const exhaustive: never = type;
	return exhaustive;
}

function assertEncodedWorkerFactRecord(value: Record<string, unknown>): void {
	assertExactKeys(value, ["type", "graphId", "itemId", "runtimeId", "sessionId", "fact"], "record");
	assertBoundedIdentity(value.graphId, "graphId", "record");
	assertBoundedIdentity(value.itemId, "itemId", "record");
	assertBoundedIdentity(value.runtimeId, "runtimeId", "record", MAXIMUM_DERIVED_WORKER_ID_LENGTH);
	assertBoundedIdentity(value.sessionId, "sessionId", "record", MAXIMUM_DERIVED_WORKER_ID_LENGTH);
	assertEncodedWorkerFact(value.fact);
}

function decodeEnvelope(line: string, expectedSequence: number): JournalEnvelope {
	const value: unknown = JSON.parse(line);
	if (isRecord(value) && value.version === 1) {
		throw new Error("Unsupported Work Journal version 1; this build requires version 2");
	}
	if (
		!isRecord(value) ||
		value.version !== 2 ||
		value.sequence !== expectedSequence ||
		!isRecord(value.record) ||
		typeof value.record.type !== "string" ||
		!RECORD_TYPES.has(value.record.type)
	) {
		throw new Error(`Invalid Work Journal record envelope at sequence ${expectedSequence}`);
	}
	if (value.record.type === "worker_fact") assertEncodedWorkerFactRecord(value.record);
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
		if (record.type === "worker_fact") assertEncodedWorkerFactRecord(record as unknown as Record<string, unknown>);
		const durableRecord = structuredClone(record);
		await this.#enqueue(async () => {
			const sequence = this.#sequence + 1;
			const envelope: JournalEnvelope = { version: 2, sequence, record: durableRecord };
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
