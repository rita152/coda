import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import type { ProcessRunner, ProcessRunResult } from "./process-runner.ts";

interface NodeProcessRunnerOptions {
	readonly platform: NodeJS.Platform;
	readonly killGraceMs?: number;
}

interface VisibleSlice {
	readonly visible: string;
	readonly overflow: string;
}

class OutputBudget {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	#bytes = 0;
	#lines = 0;
	#atLineStart = true;
	#saturated = false;

	constructor(maxBytes: number, maxLines: number) {
		this.#maxBytes = maxBytes;
		this.#maxLines = maxLines;
	}

	get saturated(): boolean {
		return this.#saturated;
	}

	take(text: string): VisibleSlice {
		let visible = "";
		let overflow = "";
		for (const character of text) {
			if (this.#saturated) {
				overflow += character;
				continue;
			}
			const bytes = Buffer.byteLength(character);
			const nextLines = this.#lines + (this.#atLineStart ? 1 : 0);
			if (this.#bytes + bytes > this.#maxBytes || nextLines > this.#maxLines) {
				this.#saturated = true;
				overflow += character;
				continue;
			}
			visible += character;
			this.#bytes += bytes;
			if (this.#atLineStart) this.#lines = nextLines;
			this.#atLineStart = character === "\n";
		}
		return { visible, overflow };
	}
}

function abortError(): Error {
	const error = new Error("Process execution was aborted");
	error.name = "AbortError";
	return error;
}

export function createNodeProcessRunner(options: NodeProcessRunnerOptions): ProcessRunner {
	const killGraceMs = options.killGraceMs ?? 1_000;
	return {
		run: async (request): Promise<ProcessRunResult> => {
			if (request.signal.aborted) throw abortError();
			return new Promise<ProcessRunResult>((resolve, reject) => {
				const child = spawn(request.executable, [...request.args], {
					cwd: request.cwd,
					env: { ...request.environment },
					stdio: ["ignore", "pipe", "pipe"],
					detached: options.platform !== "win32",
					shell: false,
				});
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				const budget = new OutputBudget(request.maxOutputBytes, request.maxOutputLines);
				const stdout: string[] = [];
				const stderr: string[] = [];
				let overflow: WriteStream | undefined;
				let overflowFailure: unknown;
				let timedOut = false;
				let aborted = false;
				let settled = false;
				let observerFailure: unknown;
				let killTimer: NodeJS.Timeout | undefined;

				const writeOverflow = (channel: "stderr" | "stdout", text: string): void => {
					if (text.length === 0 || !request.overflowPath) return;
					if (!overflow) {
						overflow = createWriteStream(request.overflowPath, { flags: "wx", mode: 0o600 });
						overflow.on("error", (error) => {
							overflowFailure = error;
						});
					}
					overflow.write(`\n[${channel}]\n${text}`);
				};
				const receive = (channel: "stderr" | "stdout", chunk: string): void => {
					try {
						request.onOutput?.({ channel, text: chunk });
					} catch (error) {
						observerFailure ??= error;
						terminate();
					}
					const slice = budget.take(chunk);
					(channel === "stdout" ? stdout : stderr).push(slice.visible);
					writeOverflow(channel, slice.overflow);
				};
				child.stdout.on("data", (chunk: string) => receive("stdout", chunk));
				child.stderr.on("data", (chunk: string) => receive("stderr", chunk));

				const signalProcess = (signal: NodeJS.Signals): void => {
					if (!child.pid) return;
					try {
						if (options.platform === "win32") child.kill(signal);
						else process.kill(-child.pid, signal);
					} catch {
						child.kill(signal);
					}
				};
				const terminate = (): void => {
					signalProcess("SIGTERM");
					killTimer = setTimeout(() => signalProcess("SIGKILL"), killGraceMs);
					killTimer.unref();
				};
				const onAbort = (): void => {
					aborted = true;
					terminate();
				};
				request.signal.addEventListener("abort", onAbort, { once: true });
				const timeout = setTimeout(() => {
					timedOut = true;
					terminate();
				}, request.timeoutMs);
				timeout.unref();

				const finishOverflow = async (): Promise<void> => {
					if (!overflow) return;
					await new Promise<void>((resolveStream) => overflow?.end(resolveStream));
					if (overflowFailure !== undefined) throw overflowFailure;
				};
				const cleanup = (): void => {
					clearTimeout(timeout);
					if (killTimer) clearTimeout(killTimer);
					request.signal.removeEventListener("abort", onAbort);
				};
				child.once("error", (error) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				});
				child.once("close", (exitCode, signal) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (options.platform !== "win32") signalProcess("SIGTERM");
					void finishOverflow().then(
						() => {
							if (observerFailure !== undefined) {
								reject(observerFailure);
								return;
							}
							if (aborted) {
								reject(abortError());
								return;
							}
							resolve({
								exitCode,
								signal,
								stdout: stdout.join(""),
								stderr: stderr.join(""),
								timedOut,
								truncated: budget.saturated,
								overflowPath: overflow ? request.overflowPath : undefined,
							});
						},
						(error) => reject(error),
					);
				});
			});
		},
	};
}
