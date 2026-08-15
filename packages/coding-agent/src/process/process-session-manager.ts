import type { IdGenerator } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import type {
	ProcessOutputChunk,
	ProcessRunResult,
	ProcessSession,
	ProcessSessionRunner,
} from "../host/process-runner.ts";
import {
	createToolOutputCapture,
	discardStoredToolOutput,
	type StoredToolOutput,
	type ToolOutputCapture,
} from "./output-store.ts";

const DEFAULT_MAX_POLL_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_MAX_POLL_OUTPUT_LINES = 2_000;

export type ProcessSessionState = "running" | "completed" | "failed" | "stopped" | "stale";

export interface ProcessSessionSnapshot {
	readonly processId: string;
	readonly state: ProcessSessionState;
	readonly output: string;
	readonly truncated: boolean;
	readonly outputOmitted: boolean;
	readonly outputRef?: string;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly stderrPresent: boolean;
	readonly failure?: string;
}

export interface ProcessSessionWriteResult {
	readonly accepted: boolean;
	readonly snapshot: ProcessSessionSnapshot;
	readonly reason?: string;
}

export interface ProcessSessionStartRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
}

interface ProcessRecord {
	readonly id: string;
	readonly sessionId: string | undefined;
	readonly handle: ProcessSession;
	readonly output: IncrementalOutputWindow;
	capture: ToolOutputCapture | undefined;
	captureUsable: boolean;
	stored: StoredToolOutput | undefined;
	result: ProcessRunResult | undefined;
	failure: string | undefined;
	terminal: boolean;
	explicitlyStopped: boolean;
	stderrPresent: boolean;
	outputOmitted: boolean;
	settled: Promise<void>;
}

interface OutputSlice {
	readonly text: string;
	readonly truncated: boolean;
}

class IncrementalOutputWindow {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	#text = "";
	#bytes = 0;
	#lines = 0;
	#atLineStart = true;
	#saturated = false;
	#lastChannel: ProcessOutputChunk["channel"] | undefined;

	constructor(maxBytes: number, maxLines: number) {
		this.#maxBytes = maxBytes;
		this.#maxLines = maxLines;
	}

	append(chunk: ProcessOutputChunk): void {
		const header = this.#lastChannel === chunk.channel ? "" : `${this.#lastChannel ? "\n" : ""}[${chunk.channel}]\n`;
		this.#lastChannel = chunk.channel;
		for (const character of `${header}${chunk.text}`) {
			if (this.#saturated) continue;
			const bytes = Buffer.byteLength(character);
			const nextLines = this.#lines + (this.#atLineStart ? 1 : 0);
			if (this.#bytes + bytes > this.#maxBytes || nextLines > this.#maxLines) {
				this.#saturated = true;
				continue;
			}
			this.#text += character;
			this.#bytes += bytes;
			if (this.#atLineStart) this.#lines = nextLines;
			this.#atLineStart = character === "\n";
		}
	}

	drain(): OutputSlice {
		const slice = Object.freeze({ text: this.#text, truncated: this.#saturated });
		this.#text = "";
		this.#bytes = 0;
		this.#lines = 0;
		this.#atLineStart = true;
		this.#saturated = false;
		this.#lastChannel = undefined;
		return slice;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validProcessId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(value);
}

function staleSnapshot(processId: string): ProcessSessionSnapshot {
	return Object.freeze({
		processId,
		state: "stale",
		output: "",
		truncated: false,
		outputOmitted: false,
		timedOut: false,
		stderrPresent: false,
	});
}

export class ProcessSessionManager {
	readonly #fileSystem: FileSystem;
	readonly #homeDirectory: string;
	readonly #runner: ProcessSessionRunner;
	readonly #idGenerator: IdGenerator;
	readonly #maxOutputBytes: number;
	readonly #maxOutputLines: number;
	readonly #sessions = new Map<string, ProcessRecord>();
	readonly #allocatedIds = new Set<string>();
	#closed = false;

	constructor(options: {
		readonly fileSystem: FileSystem;
		readonly homeDirectory: string;
		readonly runner: ProcessSessionRunner;
		readonly idGenerator: IdGenerator;
		readonly maxPollOutputBytes?: number;
		readonly maxPollOutputLines?: number;
	}) {
		this.#fileSystem = options.fileSystem;
		this.#homeDirectory = options.homeDirectory;
		this.#runner = options.runner;
		this.#idGenerator = options.idGenerator;
		this.#maxOutputBytes = options.maxPollOutputBytes ?? DEFAULT_MAX_POLL_OUTPUT_BYTES;
		this.#maxOutputLines = options.maxPollOutputLines ?? DEFAULT_MAX_POLL_OUTPUT_LINES;
		if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0) {
			throw new Error("Process poll output byte limit must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.#maxOutputLines) || this.#maxOutputLines <= 0) {
			throw new Error("Process poll output line limit must be a positive safe integer");
		}
	}

	async start(request: ProcessSessionStartRequest, sessionId?: string): Promise<ProcessSessionSnapshot> {
		if (this.#closed) throw new Error("ProcessSessionManager is closed");
		request.signal.throwIfAborted();
		const id = this.#idGenerator.generate("process_session");
		if (!validProcessId(id) || this.#allocatedIds.has(id)) {
			throw new Error("IdGenerator returned an invalid or duplicate process identity");
		}
		this.#allocatedIds.add(id);
		const capture = await createToolOutputCapture(this.#fileSystem, this.#homeDirectory, `process-session:${id}`);
		const output = new IncrementalOutputWindow(this.#maxOutputBytes, this.#maxOutputLines);
		let stderrPresent = false;
		let activeRecord: ProcessRecord | undefined;
		const lifetime = new AbortController();
		const abortLaunch = () => lifetime.abort();
		request.signal.addEventListener("abort", abortLaunch, { once: true });
		let handle: ProcessSession;
		try {
			handle = await this.#runner.start({
				...request,
				signal: lifetime.signal,
				maxOutputBytes: this.#maxOutputBytes,
				maxOutputLines: this.#maxOutputLines,
				onOutput: (chunk) => {
					if (chunk.channel === "stderr" && chunk.text.length > 0) {
						stderrPresent = true;
						if (activeRecord) activeRecord.stderrPresent = true;
					}
					output.append(chunk);
					capture?.append(chunk);
				},
			});
		} catch (error) {
			const stored = await capture?.finish();
			if (stored) await discardStoredToolOutput(this.#fileSystem, stored);
			throw error;
		} finally {
			request.signal.removeEventListener("abort", abortLaunch);
		}

		const record: ProcessRecord = {
			id,
			sessionId,
			handle,
			output,
			capture,
			captureUsable: capture !== undefined,
			stored: undefined,
			result: undefined,
			failure: undefined,
			terminal: false,
			explicitlyStopped: false,
			stderrPresent,
			outputOmitted: false,
			settled: Promise.resolve(),
		};
		activeRecord = record;
		this.#sessions.set(id, record);
		record.settled = handle.completion.then(
			async (result) => {
				record.result = result;
				record.terminal = true;
				record.stderrPresent ||= stderrPresent || result.stderr.length > 0;
				record.stored = await record.capture?.finish();
				record.captureUsable &&= record.stored !== undefined;
			},
			async (error) => {
				record.failure = errorMessage(error);
				record.terminal = true;
				record.stderrPresent ||= stderrPresent;
				record.stored = await record.capture?.finish();
				record.captureUsable &&= record.stored !== undefined;
			},
		);
		void record.settled.catch(() => undefined);
		return this.#snapshot(record, false, false);
	}

	async poll(processId: string): Promise<ProcessSessionSnapshot> {
		const record = this.#sessions.get(processId);
		if (!record) return staleSnapshot(processId);
		return this.#snapshot(record, true, true);
	}

	async write(processId: string, input: string, closeStdin = false): Promise<ProcessSessionWriteResult> {
		const record = this.#sessions.get(processId);
		if (!record) {
			return Object.freeze({
				accepted: false,
				snapshot: staleSnapshot(processId),
				reason: "stale process identity",
			});
		}
		if (record.terminal) {
			return Object.freeze({
				accepted: false,
				snapshot: await this.#snapshot(record, false, false),
				reason: "process is no longer running",
			});
		}
		try {
			if (closeStdin) await record.handle.closeStdin(input);
			else await record.handle.write(input);
			return Object.freeze({ accepted: true, snapshot: await this.#snapshot(record, false, false) });
		} catch (error) {
			return Object.freeze({
				accepted: false,
				snapshot: await this.#snapshot(record, false, false),
				reason: errorMessage(error),
			});
		}
	}

	async stop(processId: string): Promise<ProcessSessionSnapshot> {
		const record = this.#sessions.get(processId);
		if (!record) return staleSnapshot(processId);
		if (!record.terminal) {
			record.explicitlyStopped = true;
			await record.handle.stop().catch(() => undefined);
			await record.settled;
		}
		return this.#snapshot(record, true, true);
	}

	async waitForSettlement(processId: string): Promise<void> {
		const record = this.#sessions.get(processId);
		if (!record) return;
		await record.settled;
	}

	async retireSession(sessionId: string): Promise<void> {
		const records = [...this.#sessions.values()].filter((record) => record.sessionId === sessionId);
		await this.#retire(records);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#retire([...this.#sessions.values()]);
	}

	async #retire(records: readonly ProcessRecord[]): Promise<void> {
		await Promise.all(
			records.map(async (record) => {
				if (!record.terminal) {
					record.explicitlyStopped = true;
					await record.handle.stop().catch(() => undefined);
				}
				await record.settled;
				if (record.stored && (!record.outputOmitted || !record.captureUsable)) {
					await discardStoredToolOutput(this.#fileSystem, record.stored);
				}
				if (this.#sessions.get(record.id) === record) this.#sessions.delete(record.id);
			}),
		);
	}

	async #snapshot(
		record: ProcessRecord,
		consumeTerminal: boolean,
		drainOutput: boolean,
	): Promise<ProcessSessionSnapshot> {
		if (record.terminal) await record.settled;
		const output = drainOutput ? record.output.drain() : { text: "", truncated: false };
		record.outputOmitted ||= output.truncated;
		if (output.truncated && record.capture && record.captureUsable && !record.terminal) {
			record.captureUsable = await record.capture.flush();
		}
		if (record.terminal) await record.settled;
		const result = record.result;
		const state: ProcessSessionState = !record.terminal
			? "running"
			: record.failure
				? "failed"
				: record.explicitlyStopped
					? "stopped"
					: result?.timedOut || (result?.exitCode !== 0 && result?.exitCode !== undefined)
						? "failed"
						: "completed";
		const storedTruncated = record.outputOmitted && record.stored?.storedTruncated === true;
		const truncated = output.truncated || storedTruncated;
		const outputRef =
			record.outputOmitted && record.captureUsable
				? (record.stored?.outputRef ?? record.capture?.outputRef)
				: undefined;
		const snapshot = Object.freeze({
			processId: record.id,
			state,
			output: output.text,
			truncated,
			outputOmitted: record.outputOmitted,
			...(outputRef ? { outputRef } : {}),
			...(record.terminal ? { exitCode: result?.exitCode ?? null, signal: result?.signal ?? null } : {}),
			timedOut: result?.timedOut ?? false,
			stderrPresent: record.stderrPresent,
			...(record.failure ? { failure: record.failure } : {}),
		});
		if (consumeTerminal && record.terminal) {
			this.#sessions.delete(record.id);
			if (record.stored && (!record.outputOmitted || !record.captureUsable)) {
				await discardStoredToolOutput(this.#fileSystem, record.stored);
			}
		}
		return snapshot;
	}
}
