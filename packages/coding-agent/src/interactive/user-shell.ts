import { isAbsolute } from "node:path";
import type { ProcessRunner, ProcessRunResult } from "../host/process-runner.ts";

const USER_SHELL_TIMEOUT_MS = 60 * 60 * 1_000;
const USER_SHELL_MAX_OUTPUT_BYTES = 50 * 1_024;
const USER_SHELL_MAX_OUTPUT_LINES = 2_000;

export type UserShellStatus = "running" | "success" | "failed" | "timed_out" | "cancelled" | "unsupported";

export interface UserShellSnapshot {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly status: UserShellStatus;
	readonly output: string;
	readonly truncated: boolean;
	readonly omittedBytes: number;
	readonly omittedLines: number;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly durationMs?: number;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly error?: string;
}

export interface UserShellOptions {
	readonly processRunner: ProcessRunner;
	readonly platform: NodeJS.Platform;
	readonly workspace: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly clock: { now(): number };
	readonly onUpdate: (snapshot: UserShellSnapshot) => void;
}

/** Runs one explicit user-authorized local Shell command and owns its bounded live transcript. */
export class UserShell {
	readonly #options: UserShellOptions;
	#active?: AbortController;

	constructor(options: UserShellOptions) {
		this.#options = options;
	}

	get running(): boolean {
		return this.#active !== undefined;
	}

	cancel(): boolean {
		if (!this.#active) return false;
		this.#active.abort();
		return true;
	}

	async run(id: string, command: string): Promise<UserShellSnapshot> {
		if (this.#active) throw new Error("A local Shell command is already running");
		const startedAt = this.#options.clock.now();
		const output = new BoundedShellOutput(USER_SHELL_MAX_OUTPUT_BYTES, USER_SHELL_MAX_OUTPUT_LINES);
		let current = shellSnapshot({
			id,
			command,
			cwd: this.#options.workspace,
			status: "running",
			output,
			startedAt,
		});
		this.#options.onUpdate(current);

		if (this.#options.platform === "win32") {
			current = shellSnapshot({
				id,
				command,
				cwd: this.#options.workspace,
				status: "unsupported",
				output,
				startedAt,
				finishedAt: this.#options.clock.now(),
				error: "Local Shell mode is currently supported on macOS and Unix only",
			});
			this.#options.onUpdate(current);
			return current;
		}

		const controller = new AbortController();
		this.#active = controller;
		try {
			const environment = definedEnvironment(this.#options.environment);
			const configuredShell = environment.SHELL;
			const executable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
			const execute = (candidate: string) =>
				this.#options.processRunner.run({
					executable: candidate,
					args: ["-lc", command],
					cwd: this.#options.workspace,
					environment,
					signal: controller.signal,
					timeoutMs: USER_SHELL_TIMEOUT_MS,
					maxOutputBytes: USER_SHELL_MAX_OUTPUT_BYTES,
					maxOutputLines: USER_SHELL_MAX_OUTPUT_LINES,
					onOutput: ({ text }) => {
						output.append(text);
						this.#options.onUpdate(
							shellSnapshot({
								id,
								command,
								cwd: this.#options.workspace,
								status: "running",
								output,
								startedAt,
							}),
						);
					},
				});
			let result: ProcessRunResult;
			try {
				result = await execute(executable);
			} catch (error) {
				if (executable === "/bin/sh" || !isExecutableUnavailable(error)) throw error;
				result = await execute("/bin/sh");
			}
			output.finish();
			current = shellSnapshot({
				id,
				command,
				cwd: this.#options.workspace,
				status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "success" : "failed",
				output,
				startedAt,
				finishedAt: this.#options.clock.now(),
				exitCode: result.exitCode,
				signal: result.signal,
			});
		} catch (error) {
			output.finish();
			const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
			current = shellSnapshot({
				id,
				command,
				cwd: this.#options.workspace,
				status: cancelled ? "cancelled" : "failed",
				output,
				startedAt,
				finishedAt: this.#options.clock.now(),
				...(!cancelled ? { error: error instanceof Error ? error.message : String(error) } : {}),
			});
		} finally {
			if (this.#active === controller) this.#active = undefined;
		}
		this.#options.onUpdate(current);
		return current;
	}
}

interface SnapshotInput {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly status: UserShellStatus;
	readonly output: BoundedShellOutput;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly error?: string;
}

function shellSnapshot(input: SnapshotInput): UserShellSnapshot {
	const transcript = input.output.snapshot();
	return Object.freeze({
		id: input.id,
		command: input.command,
		cwd: input.cwd,
		status: input.status,
		output: transcript.text,
		truncated: transcript.truncated,
		omittedBytes: transcript.omittedBytes,
		omittedLines: transcript.omittedLines,
		startedAt: input.startedAt,
		...(input.finishedAt !== undefined
			? { finishedAt: input.finishedAt, durationMs: Math.max(0, input.finishedAt - input.startedAt) }
			: {}),
		...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
		...(input.signal !== undefined ? { signal: input.signal } : {}),
		...(input.error ? { error: safeInline(input.error) } : {}),
	});
}

function definedEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function isExecutableUnavailable(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

interface OutputToken {
	readonly bytes: number;
	readonly lineBreaks: number;
	readonly safe: string;
}

/** Keeps a contiguous head and tail while measuring the decoded raw stream before sanitization. */
class BoundedShellOutput {
	readonly #headBytesLimit: number;
	readonly #tailBytesLimit: number;
	readonly #headLinesLimit: number;
	readonly #tailLinesLimit: number;
	readonly #sanitizer = new StreamingTerminalSanitizer();
	readonly #head: OutputToken[] = [];
	readonly #tail: OutputToken[] = [];
	#tailStart = 0;
	#headBytes = 0;
	#headLines = 0;
	#tailBytes = 0;
	#tailLines = 0;
	#totalBytes = 0;
	#totalLines = 0;
	#headClosed = false;
	#truncated = false;
	#lastRawCarriageReturn = false;
	#finished = false;

	constructor(maxBytes: number, maxLines: number) {
		this.#headBytesLimit = Math.floor(maxBytes / 2);
		this.#tailBytesLimit = maxBytes - this.#headBytesLimit;
		this.#headLinesLimit = Math.floor(maxLines / 2);
		this.#tailLinesLimit = maxLines - this.#headLinesLimit;
	}

	append(text: string): void {
		if (this.#finished) throw new Error("Cannot append to a finished Shell transcript");
		for (const character of text) {
			const lineBreaks = this.#rawLineBreaks(character);
			this.#appendToken({
				bytes: Buffer.byteLength(character),
				lineBreaks,
				safe: this.#sanitizer.push(character),
			});
		}
	}

	finish(): void {
		if (this.#finished) return;
		this.#finished = true;
		const safe = this.#sanitizer.finish();
		if (safe) this.#appendSafeRemainder(safe);
	}

	snapshot(): {
		readonly text: string;
		readonly truncated: boolean;
		readonly omittedBytes: number;
		readonly omittedLines: number;
	} {
		const headText = this.#head.map(({ safe }) => safe).join("");
		const tailText = this.#tail
			.slice(this.#tailStart)
			.map(({ safe }) => safe)
			.join("");
		const omittedBytes = Math.max(0, this.#totalBytes - this.#headBytes - this.#tailBytes);
		const omittedLines = Math.max(0, this.#totalLines - this.#headLines - this.#tailLines);
		if (!this.#truncated) {
			return { text: `${headText}${tailText}`, truncated: false, omittedBytes: 0, omittedLines: 0 };
		}
		const marker = `[... ${omittedBytes} bytes${omittedLines > 0 ? ` / ${omittedLines} lines` : ""} omitted ...]`;
		return {
			text: joinTranscriptSections(headText, marker, tailText),
			truncated: true,
			omittedBytes,
			omittedLines,
		};
	}

	#appendToken(token: OutputToken): void {
		this.#totalBytes += token.bytes;
		this.#totalLines += token.lineBreaks;
		if (
			!this.#headClosed &&
			this.#headBytes + token.bytes <= this.#headBytesLimit &&
			this.#headLines + token.lineBreaks <= this.#headLinesLimit
		) {
			this.#head.push(token);
			this.#headBytes += token.bytes;
			this.#headLines += token.lineBreaks;
			return;
		}
		this.#headClosed = true;
		this.#tail.push(token);
		this.#tailBytes += token.bytes;
		this.#tailLines += token.lineBreaks;
		while (this.#tailBytes > this.#tailBytesLimit || this.#tailLines > this.#tailLinesLimit) {
			const removed = this.#tail[this.#tailStart++];
			if (!removed) break;
			this.#tailBytes -= removed.bytes;
			this.#tailLines -= removed.lineBreaks;
			this.#truncated = true;
		}
		if (this.#tailStart > 4_096 && this.#tailStart * 2 > this.#tail.length) {
			this.#tail.splice(0, this.#tailStart);
			this.#tailStart = 0;
		}
	}

	#appendSafeRemainder(safe: string): void {
		if (this.#headClosed) {
			const index = this.#tail.length - 1;
			const previous = index >= this.#tailStart ? this.#tail[index] : undefined;
			if (previous) this.#tail[index] = { ...previous, safe: `${previous.safe}${safe}` };
			else this.#tail.push({ bytes: 0, lineBreaks: 0, safe });
			return;
		}
		const previous = this.#head.pop();
		if (previous) this.#head.push({ ...previous, safe: `${previous.safe}${safe}` });
		else this.#head.push({ bytes: 0, lineBreaks: 0, safe });
	}

	#rawLineBreaks(character: string): number {
		if (character === "\r") {
			this.#lastRawCarriageReturn = true;
			return 1;
		}
		if (character === "\n") {
			const count = this.#lastRawCarriageReturn ? 0 : 1;
			this.#lastRawCarriageReturn = false;
			return count;
		}
		this.#lastRawCarriageReturn = false;
		return 0;
	}
}

type SanitizerState = "text" | "escape" | "csi" | "string" | "string_escape";

class StreamingTerminalSanitizer {
	#state: SanitizerState = "text";
	#pendingCarriageReturn = false;

	push(character: string): string {
		switch (this.#state) {
			case "escape":
				if (character === "[") this.#state = "csi";
				else if ("]P_^".includes(character)) this.#state = "string";
				else this.#state = character === "\u001b" ? "escape" : "text";
				return "";
			case "csi": {
				const code = character.codePointAt(0) ?? 0;
				if (character === "\u001b") this.#state = "escape";
				else if (code >= 0x40 && code <= 0x7e) this.#state = "text";
				return "";
			}
			case "string":
				if (character === "\u0007" || character === "\u009c") this.#state = "text";
				else if (character === "\u001b") this.#state = "string_escape";
				return "";
			case "string_escape":
				this.#state = character === "\\" ? "text" : character === "\u001b" ? "string_escape" : "string";
				return "";
			case "text":
				return this.#pushText(character);
		}
	}

	finish(): string {
		const remainder = this.#pendingCarriageReturn ? "\n" : "";
		this.#pendingCarriageReturn = false;
		this.#state = "text";
		return remainder;
	}

	#pushText(character: string): string {
		if (character === "\u001b") {
			this.#state = "escape";
			return this.#flushCarriageReturn();
		}
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x9b) {
			this.#state = "csi";
			return this.#flushCarriageReturn();
		}
		if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
			this.#state = "string";
			return this.#flushCarriageReturn();
		}
		if (character === "\r") {
			const previous = this.#flushCarriageReturn();
			this.#pendingCarriageReturn = true;
			return previous;
		}
		if (character === "\n") {
			this.#pendingCarriageReturn = false;
			return "\n";
		}
		const prefix = this.#flushCarriageReturn();
		if (
			(code < 0x20 && character !== "\t") ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			return prefix;
		}
		return `${prefix}${character}`;
	}

	#flushCarriageReturn(): string {
		if (!this.#pendingCarriageReturn) return "";
		this.#pendingCarriageReturn = false;
		return "\n";
	}
}

function joinTranscriptSections(head: string, marker: string, tail: string): string {
	return `${head}${head && !head.endsWith("\n") ? "\n" : ""}${marker}${tail && !tail.startsWith("\n") ? "\n" : ""}${tail}`;
}

function safeInline(value: string): string {
	const sanitizer = new StreamingTerminalSanitizer();
	let safe = "";
	for (const character of value) safe += sanitizer.push(character);
	return `${safe}${sanitizer.finish()}`.replace(/[\r\n]+/g, " ");
}
