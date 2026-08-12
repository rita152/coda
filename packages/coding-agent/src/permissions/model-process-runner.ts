import { createWriteStream, type WriteStream } from "node:fs";
import {
	execute,
	type ManagedNetworkPolicy,
	type ReadAccessPolicy,
	type SandboxViolation,
	startProcess,
} from "@coda/sandbox";
import type { ProcessOutputChunk, ProcessRunRequest, ProcessRunResult } from "../host/process-runner.ts";
import { type PermissionAuditSink, permissionPolicyAuditSnapshot } from "./audit.ts";

export interface ModelProcessAuthority {
	readonly readAccessPolicy: ReadAccessPolicy;
	readonly managedNetwork?: ManagedNetworkPolicy;
	readonly auditContext?: { readonly invocationId: string; readonly toolName: string };
}

export interface ModelProcessRunResult extends ProcessRunResult {
	readonly backend: "none" | "macos-seatbelt" | "linux-bwrap";
	readonly denial?: SandboxViolation;
}

export interface ModelProcessRunner {
	run(request: ProcessRunRequest, authority: ModelProcessAuthority): Promise<ModelProcessRunResult>;
}

export interface ModelProcessSession {
	readonly backend: ModelProcessRunResult["backend"];
	readonly completion: Promise<ModelProcessRunResult>;
	write(input: string | Uint8Array): Promise<void>;
	closeStdin(input?: string | Uint8Array): Promise<void>;
	stop(): Promise<ModelProcessRunResult>;
}

export interface ModelProcessSessionRunner {
	start(request: ProcessRunRequest, authority: ModelProcessAuthority): Promise<ModelProcessSession>;
}

async function auditProcessResult(
	result: ModelProcessRunResult,
	authority: ModelProcessAuthority,
	audit: PermissionAuditSink,
): Promise<void> {
	const context = authority.auditContext;
	if (!context) return;
	await audit(
		Object.freeze({
			type: "sandbox_execution",
			invocationId: context.invocationId,
			toolName: context.toolName,
			policy: permissionPolicyAuditSnapshot(authority.readAccessPolicy.sandboxPolicy),
			backend: result.backend,
			outcome: result.denial
				? "sandbox-denial"
				: result.timedOut
					? "timed-out"
					: result.exitCode === 0
						? "success"
						: "normal-failure",
			exitCode: result.exitCode,
			signal: result.signal,
			...(result.denial ? { denial: result.denial } : {}),
		}),
	);
}

async function auditProcessFailure(
	error: unknown,
	authority: ModelProcessAuthority,
	audit: PermissionAuditSink,
): Promise<void> {
	const context = authority.auditContext;
	if (!context) return;
	const cancelled = error instanceof Error && error.name === "AbortError";
	await audit(
		Object.freeze({
			type: "sandbox_execution",
			invocationId: context.invocationId,
			toolName: context.toolName,
			policy: permissionPolicyAuditSnapshot(authority.readAccessPolicy.sandboxPolicy),
			outcome: cancelled ? "cancelled" : "launch-failed",
			error: error instanceof Error ? error.message : String(error),
		}),
	);
}

export function createAuditedModelProcessRunner(
	delegate: ModelProcessRunner,
	audit: PermissionAuditSink,
): ModelProcessRunner {
	return {
		run: async (request, authority) => {
			try {
				const result = await delegate.run(request, authority);
				await auditProcessResult(result, authority, audit);
				return result;
			} catch (error) {
				await auditProcessFailure(error, authority, audit);
				throw error;
			}
		},
	};
}

export function createAuditedModelProcessSessionRunner(
	delegate: ModelProcessSessionRunner,
	audit: PermissionAuditSink,
): ModelProcessSessionRunner {
	return {
		start: async (request, authority) => {
			let session: ModelProcessSession;
			try {
				session = await delegate.start(request, authority);
			} catch (error) {
				await auditProcessFailure(error, authority, audit);
				throw error;
			}
			const completion = session.completion.then(
				async (result) => {
					await auditProcessResult(result, authority, audit);
					return result;
				},
				async (error) => {
					await auditProcessFailure(error, authority, audit);
					throw error;
				},
			);
			void completion.catch(() => undefined);
			return Object.freeze({
				backend: session.backend,
				completion,
				write: (input: string | Uint8Array) => session.write(input),
				closeStdin: (input?: string | Uint8Array) => session.closeStdin(input),
				stop: async () => {
					await session.stop();
					return completion;
				},
			});
		},
	};
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

export function createModelProcessRunner(): ModelProcessRunner {
	return {
		run: async (request, authority) => {
			const budget = new OutputBudget(request.maxOutputBytes, request.maxOutputLines);
			const stdout: string[] = [];
			const stderr: string[] = [];
			let overflow: WriteStream | undefined;
			let overflowFailure: unknown;
			const writeOverflow = (channel: ProcessOutputChunk["channel"], text: string) => {
				if (!text || !request.overflowPath) return;
				if (!overflow) {
					overflow = createWriteStream(request.overflowPath, { flags: "wx", mode: 0o600 });
					overflow.on("error", (error) => {
						overflowFailure = error;
					});
				}
				overflow.write(`\n[${channel}]\n${text}`);
			};
			const receive = (chunk: ProcessOutputChunk) => {
				request.onOutput?.(chunk);
				const slice = budget.take(chunk.text);
				(chunk.channel === "stdout" ? stdout : stderr).push(slice.visible);
				writeOverflow(chunk.channel, slice.overflow);
			};
			let result: Awaited<ReturnType<typeof execute>>;
			try {
				result = await execute(
					{
						command: [request.executable, ...request.args],
						cwd: request.cwd,
						environment: request.environment,
						policy: authority.readAccessPolicy.sandboxPolicy,
						timeoutMs: request.timeoutMs,
						signal: request.signal,
						managedNetwork: authority.managedNetwork,
						maxOutputBytes: Math.max(request.maxOutputBytes, 64 * 1024),
					},
					{ onOutput: receive },
				);
			} finally {
				if (overflow) await new Promise<void>((resolve) => overflow?.end(resolve));
			}
			if (overflowFailure !== undefined) throw overflowFailure;
			if (result.status === "cancelled") throw abortError();
			return {
				exitCode: result.exitCode,
				signal: result.signal,
				stdout: stdout.join(""),
				stderr: stderr.join(""),
				timedOut: result.status === "timed-out",
				truncated: budget.saturated || result.truncated,
				overflowPath: overflow ? request.overflowPath : undefined,
				backend: result.backend,
				denial: result.status === "denied" ? result.denial : undefined,
			};
		},
	};
}

export function createModelProcessSessionRunner(): ModelProcessSessionRunner {
	return {
		start: async (request, authority) => {
			const session = await startProcess(
				{
					command: [request.executable, ...request.args],
					cwd: request.cwd,
					environment: request.environment,
					policy: authority.readAccessPolicy.sandboxPolicy,
					timeoutMs: request.timeoutMs,
					signal: request.signal,
					managedNetwork: authority.managedNetwork,
					maxOutputBytes: Math.max(request.maxOutputBytes, 64 * 1024),
				},
				{ onOutput: request.onOutput },
			);
			const completion = session.completion.then(
				(result): ModelProcessRunResult => ({
					exitCode: result.exitCode,
					signal: result.signal,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: result.status === "timed-out",
					truncated: result.truncated,
					backend: result.backend,
					denial: result.status === "denied" ? result.denial : undefined,
				}),
			);
			void completion.catch(() => undefined);
			return Object.freeze({
				backend: session.backend,
				completion,
				write: (input: string | Uint8Array) => session.write(input),
				closeStdin: (input?: string | Uint8Array) => session.closeStdin(input),
				stop: async () => {
					await session.stop();
					return completion;
				},
			});
		},
	};
}
