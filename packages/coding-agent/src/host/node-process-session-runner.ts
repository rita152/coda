import { spawn } from "node:child_process";
import type { ProcessOutputChunk, ProcessRunResult, ProcessSession, ProcessSessionRunner } from "./process-runner.ts";

interface NodeProcessSessionRunnerOptions {
	readonly platform: NodeJS.Platform;
	readonly killGraceMs?: number;
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

	take(text: string): string {
		let visible = "";
		for (const character of text) {
			if (this.#saturated) continue;
			const bytes = Buffer.byteLength(character);
			const nextLines = this.#lines + (this.#atLineStart ? 1 : 0);
			if (this.#bytes + bytes > this.#maxBytes || nextLines > this.#maxLines) {
				this.#saturated = true;
				continue;
			}
			visible += character;
			this.#bytes += bytes;
			if (this.#atLineStart) this.#lines = nextLines;
			this.#atLineStart = character === "\n";
		}
		return visible;
	}
}

function abortError(): Error {
	const error = new Error("Process execution was aborted");
	error.name = "AbortError";
	return error;
}

export function createNodeProcessSessionRunner(options: NodeProcessSessionRunnerOptions): ProcessSessionRunner {
	const killGraceMs = options.killGraceMs ?? 1_000;
	return {
		start: async (request): Promise<ProcessSession> => {
			if (request.signal.aborted) throw abortError();
			const child = spawn(request.executable, [...request.args], {
				cwd: request.cwd,
				env: { ...request.environment },
				stdio: ["pipe", "pipe", "pipe"],
				detached: options.platform !== "win32",
				shell: false,
			});
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			const budget = new OutputBudget(request.maxOutputBytes, request.maxOutputLines);
			const stdout: string[] = [];
			const stderr: string[] = [];
			let timedOut = false;
			let stopped = false;
			let settled = false;
			let stdinClosed = false;
			let observerFailure: unknown;
			let killTimer: NodeJS.Timeout | undefined;

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
				killTimer ??= setTimeout(() => signalProcess("SIGKILL"), killGraceMs);
				killTimer.unref();
			};
			const receive = (chunk: ProcessOutputChunk): void => {
				try {
					request.onOutput?.(chunk);
				} catch (error) {
					observerFailure ??= error;
					terminate();
				}
				const visible = budget.take(chunk.text);
				(chunk.channel === "stdout" ? stdout : stderr).push(visible);
			};
			child.stdout.on("data", (text: string) => receive({ channel: "stdout", text }));
			child.stderr.on("data", (text: string) => receive({ channel: "stderr", text }));
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EPIPE") return;
				observerFailure ??= error;
				terminate();
			});
			const onAbort = (): void => {
				stopped = true;
				terminate();
			};
			request.signal.addEventListener("abort", onAbort, { once: true });
			const timeout = setTimeout(() => {
				timedOut = true;
				terminate();
			}, request.timeoutMs);
			timeout.unref();
			const cleanup = (): void => {
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				request.signal.removeEventListener("abort", onAbort);
			};
			const completion = new Promise<ProcessRunResult>((resolve, reject) => {
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
					if (observerFailure !== undefined) {
						reject(observerFailure);
						return;
					}
					resolve({
						exitCode,
						signal,
						stdout: stdout.join(""),
						stderr: stderr.join(""),
						timedOut,
						truncated: budget.saturated,
					});
				});
			});
			void completion.catch(() => undefined);
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			const write = (input: string | Uint8Array): Promise<void> => {
				if (stdinClosed || settled || !child.stdin.writable) {
					return Promise.reject(new Error("Process stdin is closed"));
				}
				return new Promise<void>((resolve, reject) => {
					child.stdin.write(input, (error) => (error ? reject(error) : resolve()));
				});
			};
			const closeStdin = (input?: string | Uint8Array): Promise<void> => {
				if (stdinClosed || settled || !child.stdin.writable) return Promise.resolve();
				stdinClosed = true;
				return new Promise<void>((resolve) => {
					child.stdin.end(input, resolve);
				});
			};
			return Object.freeze({
				completion,
				write,
				closeStdin,
				stop: () => {
					if (!settled && !stopped) {
						stopped = true;
						terminate();
					}
					return completion;
				},
			});
		},
	};
}
