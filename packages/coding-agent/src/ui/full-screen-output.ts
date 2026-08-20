import { type Diagnostic, type DiagnosticSink, sanitizeTerminalText } from "@coda/tui";
import type { ApplicationIO, ApplicationOutput } from "../host/application-io.ts";

const DEFERRED_DIAGNOSTIC_CAPACITY = 64;

export interface FullScreenDiagnosticPresenter {
	presentDiagnostic(diagnostic: Diagnostic): void;
}

export interface FullScreenOutputLease {
	release(): Promise<void>;
}

export class FullScreenOutputScope {
	readonly #gate: FullScreenOutputGate | undefined;
	readonly #presenter: FullScreenDiagnosticPresenter;
	#lease?: FullScreenOutputLease;

	constructor(gate: FullScreenOutputGate | undefined, presenter: FullScreenDiagnosticPresenter) {
		this.#gate = gate;
		this.#presenter = presenter;
	}

	async start(operation: () => Promise<boolean>): Promise<boolean> {
		this.#lease ??= this.#gate?.acquire(this.#presenter);
		try {
			const started = await operation();
			if (!started) await this.#release();
			return started;
		} catch (error) {
			try {
				await this.#release();
			} catch (releaseError) {
				throw new AggregateError([error, releaseError], "Full-screen startup and output release both failed");
			}
			throw error;
		}
	}

	async stop(operation: () => Promise<void>): Promise<void> {
		let failed = false;
		let failure: unknown;
		try {
			await operation();
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			await this.#release();
		} catch (error) {
			if (failed) {
				throw new AggregateError([failure, error], "Full-screen shutdown and output release both failed");
			}
			throw error;
		}
		if (failed) throw failure;
	}

	async #release(): Promise<void> {
		const lease = this.#lease;
		this.#lease = undefined;
		await lease?.release();
	}
}

interface BufferedOutput {
	readonly channel: "stderr" | "stdout";
	readonly chunk: string;
	readonly diagnostic?: true;
}

export class FullScreenOutputGate {
	readonly #raw: ApplicationIO;
	readonly #buffer: BufferedOutput[] = [];
	#presenter?: FullScreenDiagnosticPresenter;
	#lease?: symbol;
	#tail: Promise<void> = Promise.resolve();
	#deferredDiagnostics = 0;
	#droppedDiagnostics = 0;
	readonly io: ApplicationIO;
	readonly diagnostics: DiagnosticSink;

	constructor(raw: ApplicationIO) {
		this.#raw = raw;
		this.io = Object.freeze({
			stdin: raw.stdin,
			stdout: this.#output("stdout", raw.stdout),
			stderr: this.#output("stderr", raw.stderr),
		});
		this.diagnostics = (diagnostic) =>
			this.#enqueue(async () => {
				const snapshot = Object.freeze({
					...diagnostic,
					...(diagnostic.details === undefined ? {} : { details: Object.freeze({ ...diagnostic.details }) }),
				});
				if (!this.#presenter) {
					await this.#raw.stderr.write(formatDiagnosticLine(snapshot));
					return;
				}
				if (snapshot.code.startsWith("renderer.")) {
					this.#deferDiagnostic(snapshot);
					return;
				}
				try {
					this.#presenter.presentDiagnostic(snapshot);
				} catch {
					this.#deferDiagnostic(snapshot);
				}
			});
	}

	get active(): boolean {
		return this.#lease !== undefined;
	}

	acquire(presenter: FullScreenDiagnosticPresenter): FullScreenOutputLease {
		if (this.#lease) throw new Error("A full-screen output lease is already active");
		const token = Symbol("full-screen-output");
		this.#lease = token;
		this.#presenter = presenter;
		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				await this.#enqueue(async () => {
					if (this.#lease !== token) return;
					this.#presenter = undefined;
					this.#lease = undefined;
					const buffered = this.#buffer.splice(0);
					const droppedDiagnostics = this.#droppedDiagnostics;
					this.#deferredDiagnostics = 0;
					this.#droppedDiagnostics = 0;
					for (const output of buffered) {
						await this.#raw[output.channel].write(output.chunk);
					}
					if (droppedDiagnostics > 0) {
						await this.#raw.stderr.write(
							`coda: [diagnostic.buffer-overflow] Dropped ${droppedDiagnostics} older full-screen diagnostic${droppedDiagnostics === 1 ? "" : "s"}\n`,
						);
					}
				});
			},
		};
	}

	#output(channel: BufferedOutput["channel"], raw: ApplicationOutput): ApplicationOutput {
		return Object.freeze({
			isTTY: raw.isTTY,
			write: (chunk: string) =>
				this.#enqueue(async () => {
					if (this.#presenter) {
						this.#buffer.push({ channel, chunk });
						return;
					}
					await raw.write(chunk);
				}),
		});
	}

	#deferDiagnostic(diagnostic: Diagnostic): void {
		if (this.#deferredDiagnostics >= DEFERRED_DIAGNOSTIC_CAPACITY) {
			const oldest = this.#buffer.findIndex((output) => output.diagnostic === true);
			if (oldest >= 0) this.#buffer.splice(oldest, 1);
			this.#droppedDiagnostics++;
		} else {
			this.#deferredDiagnostics++;
		}
		this.#buffer.push({ channel: "stderr", chunk: formatDiagnosticLine(diagnostic), diagnostic: true });
	}

	#enqueue(run: () => void | Promise<void>): Promise<void> {
		const result = this.#tail.then(run);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

function formatDiagnosticLine(diagnostic: Diagnostic): string {
	const code = singleLine(diagnostic.code);
	const message = singleLine(diagnostic.message);
	const details = Object.entries(diagnostic.details ?? {})
		.map(([name, value]) => `${singleLine(name)}=${jsonValue(value)}`)
		.join(" ");
	return `coda: [${code}] ${message}${details ? ` · ${details}` : ""}\n`;
}

function singleLine(value: string): string {
	return sanitizeTerminalText(value).replace(/[\r\n]+/g, " ");
}

function jsonValue(value: unknown): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		// Fall through to a quoted string representation.
	}
	if (serialized === undefined) {
		try {
			serialized = JSON.stringify(String(value));
		} catch {
			serialized = '"[unserializable]"';
		}
	}
	let escaped = "";
	for (const character of serialized) {
		const codePoint = character.codePointAt(0)!;
		escaped += codePoint >= 0x7f && codePoint <= 0x9f ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
	}
	return escaped;
}
