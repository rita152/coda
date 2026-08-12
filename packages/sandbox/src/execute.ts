import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isWsl1, prepareLinuxBubblewrap, resolveLinuxBubblewrap } from "./linux-bubblewrap.ts";
import { prepareMacosSeatbelt } from "./macos-seatbelt.ts";
import {
	type ManagedNetworkPolicy,
	type NetworkSandboxViolation,
	startManagedNetworkProxy,
} from "./managed-network-proxy.ts";
import { type CompiledSandboxPolicy, isCompiledSandboxPolicy } from "./policy.ts";

export type SandboxBackend = "none" | "macos-seatbelt" | "linux-bwrap";

export interface SandboxOutputChunk {
	readonly channel: "stdout" | "stderr";
	readonly text: string;
}

export interface SandboxExecuteRequest {
	readonly command: readonly [string, ...string[]];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly policy: Readonly<CompiledSandboxPolicy>;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/** Explicit bytes delivered to the child before stdin is closed. Omit to give the child an empty, closed stdin. */
	readonly stdin?: string | Uint8Array;
	readonly managedNetwork?: ManagedNetworkPolicy;
	/** Maximum combined stdout/stderr bytes retained in the returned result. Streaming observers still receive every chunk. */
	readonly maxOutputBytes?: number;
}

export type SandboxStartRequest = Omit<SandboxExecuteRequest, "stdin">;

export interface SandboxExecuteCallbacks {
	readonly onOutput?: (chunk: SandboxOutputChunk) => void;
	readonly onViolation?: (violation: SandboxViolation) => void;
}

/** A process-local handle that never exposes the child PID as authority. */
export interface SandboxProcess {
	readonly backend: SandboxBackend;
	readonly completion: Promise<SandboxExecutionResult>;
	write(input: string | Uint8Array): Promise<void>;
	closeStdin(input?: string | Uint8Array): Promise<void>;
	stop(): Promise<SandboxExecutionResult>;
}

interface SandboxExecutionBase {
	readonly backend: SandboxBackend;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
	readonly durationMs: number;
}

export interface SandboxExitedResult extends SandboxExecutionBase {
	readonly status: "exited";
}

export interface SandboxTimedOutResult extends SandboxExecutionBase {
	readonly status: "timed-out";
}

export interface SandboxCancelledResult extends SandboxExecutionBase {
	readonly status: "cancelled";
}

export type FileSystemDenialReason =
	| "operation_not_permitted"
	| "permission_denied"
	| "read_only_file_system"
	| "policy_denied"
	| "failed_to_write_file"
	| "sigsys";

export interface FileSystemSandboxViolation {
	readonly kind: "filesystem";
	readonly backend: "seatbelt" | "linux-sandbox";
	readonly reason: FileSystemDenialReason;
	readonly path?: string;
	readonly outputSnippet: string;
}

export type SandboxViolation = FileSystemSandboxViolation | NetworkSandboxViolation;

export interface SandboxDeniedResult extends SandboxExecutionBase {
	readonly status: "denied";
	readonly denial: SandboxViolation;
}

export type SandboxExecutionResult =
	| SandboxExitedResult
	| SandboxTimedOutResult
	| SandboxCancelledResult
	| SandboxDeniedResult;

export class SandboxExecutionError extends Error {
	readonly code:
		| "invalid_request"
		| "backend_unavailable"
		| "unsupported_platform"
		| "launch_failed"
		| "observer_failed";
	readonly cause?: unknown;

	constructor(code: SandboxExecutionError["code"], message: string, cause?: unknown) {
		super(message);
		this.name = "SandboxExecutionError";
		this.code = code;
		this.cause = cause;
	}
}

const LINUX_MANAGED_PROXY_PORT = 38_081;
const CANCELLATION_TERMINATION_GRACE_MS = 50;
const linuxHelperDigestExpectations = new Map<string, string>();

async function linuxHelperPath(): Promise<string> {
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new SandboxExecutionError("unsupported_platform", `Linux Sandbox helper is unsupported on ${process.arch}`);
	}
	const candidate = fileURLToPath(
		new URL(`../native/linux-${process.arch}/coda-linux-sandbox-helper`, import.meta.url),
	);
	try {
		const canonical = await realpath(candidate);
		let expectedDigest = linuxHelperDigestExpectations.get(candidate);
		if (expectedDigest === undefined) {
			expectedDigest = (await readFile(`${candidate}.sha256`, "utf8")).trim();
			if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error("invalid helper digest");
			linuxHelperDigestExpectations.set(candidate, expectedDigest);
		}
		const digest = createHash("sha256")
			.update(await readFile(canonical))
			.digest("hex");
		if (digest !== expectedDigest) throw new Error(`Linux Sandbox helper digest mismatch for ${canonical}`);
		await access(canonical, constants.X_OK);
		return canonical;
	} catch (error) {
		throw new SandboxExecutionError(
			"backend_unavailable",
			`Required Linux Sandbox helper is unavailable at ${candidate}`,
			error,
		);
	}
}

async function assertCanonicalPath(path: string, label: string): Promise<void> {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new SandboxExecutionError("invalid_request", `${label} must be a canonical absolute path`);
	}
	let ancestor = path;
	const suffix: string[] = [];
	for (;;) {
		try {
			const canonicalAncestor = await realpath(ancestor);
			if (join(canonicalAncestor, ...suffix) !== path) {
				throw new SandboxExecutionError("invalid_request", `${label} traverses a symbolic link: ${path}`);
			}
			return;
		} catch (error) {
			if (error instanceof SandboxExecutionError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) {
				throw new SandboxExecutionError("invalid_request", `${label} has no canonical ancestor: ${path}`);
			}
			suffix.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
}

async function validateRequest(request: SandboxExecuteRequest): Promise<void> {
	if (
		!Array.isArray(request.command) ||
		request.command.length === 0 ||
		request.command.some(
			(argument) => typeof argument !== "string" || argument.length === 0 || argument.includes("\0"),
		)
	) {
		throw new SandboxExecutionError("invalid_request", "command must contain non-empty strings without NUL bytes");
	}
	if (typeof request.cwd !== "string" || !isAbsolute(request.cwd) || normalize(request.cwd) !== request.cwd) {
		throw new SandboxExecutionError("invalid_request", "cwd must be a canonical absolute path");
	}
	if (!request.environment || typeof request.environment !== "object" || Array.isArray(request.environment)) {
		throw new SandboxExecutionError("invalid_request", "environment must be a string record");
	}
	for (const [name, value] of Object.entries(request.environment)) {
		if (!name || name.includes("=") || name.includes("\0") || typeof value !== "string" || value.includes("\0")) {
			throw new SandboxExecutionError("invalid_request", "environment must be a string record without NUL bytes");
		}
	}
	if (request.stdin !== undefined && typeof request.stdin !== "string" && !(request.stdin instanceof Uint8Array)) {
		throw new SandboxExecutionError("invalid_request", "stdin must be a string or Uint8Array");
	}
	if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
		throw new SandboxExecutionError("invalid_request", "timeoutMs must be a positive safe integer");
	}
	if (
		request.maxOutputBytes !== undefined &&
		(!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0)
	) {
		throw new SandboxExecutionError("invalid_request", "maxOutputBytes must be a positive safe integer");
	}
	const policy = request.policy as Partial<CompiledSandboxPolicy> | undefined;
	if (
		!isCompiledSandboxPolicy(policy) ||
		!(["read-only", "workspace", "full-access"] as const).includes(policy.profile as never) ||
		!(["root-scoped", "full-disk"] as const).includes(policy.readAccess as never) ||
		!(["restricted", "enabled"] as const).includes(policy.networkAccess as never) ||
		!Array.isArray(policy.readableRoots) ||
		!Array.isArray(policy.approvedReadRoots) ||
		!Array.isArray(policy.deniedReadRoots) ||
		!(policy.writableRoots === "full-disk" || Array.isArray(policy.writableRoots)) ||
		!Array.isArray(policy.protectedMetadataRoots) ||
		!Array.isArray(policy.protectedMetadataNames) ||
		!Array.isArray(policy.protectedMetadataPaths)
	) {
		throw new SandboxExecutionError("invalid_request", "policy is not a compiled Sandbox policy");
	}
	if (
		(policy.profile === "full-access" &&
			(policy.readAccess !== "full-disk" ||
				policy.writableRoots !== "full-disk" ||
				policy.networkAccess !== "enabled" ||
				policy.deniedReadRoots.length > 0)) ||
		(policy.profile !== "full-access" &&
			(policy.readAccess !== "root-scoped" || policy.writableRoots === "full-disk"))
	) {
		throw new SandboxExecutionError(
			"invalid_request",
			`policy capabilities are inconsistent with the ${policy.profile} profile`,
		);
	}
	if (
		request.managedNetwork !== undefined &&
		(!request.managedNetwork ||
			typeof request.managedNetwork !== "object" ||
			typeof request.managedNetwork.environmentId !== "string" ||
			request.managedNetwork.environmentId.length === 0 ||
			typeof request.managedNetwork.decide !== "function")
	) {
		throw new SandboxExecutionError("invalid_request", "managedNetwork must provide an environmentId and decider");
	}
	await assertCanonicalPath(request.cwd, "cwd");
	const roots = [
		...policy.readableRoots,
		...policy.approvedReadRoots,
		...policy.protectedMetadataRoots,
		...policy.deniedReadRoots,
		...(policy.writableRoots === "full-disk" ? [] : policy.writableRoots),
	];
	for (const root of new Set(roots)) {
		if (typeof root !== "string") {
			throw new SandboxExecutionError("invalid_request", "Sandbox roots must be strings");
		}
		await assertCanonicalPath(root, "Sandbox root");
	}
	for (const name of policy.protectedMetadataNames) {
		if (typeof name !== "string") {
			throw new SandboxExecutionError("invalid_request", "protected metadata names must be strings");
		}
		if (!name || basename(name) !== name || name === "." || name === "..") {
			throw new SandboxExecutionError("invalid_request", `invalid protected metadata name: ${name}`);
		}
	}
	for (const path of policy.protectedMetadataPaths) {
		if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
			throw new SandboxExecutionError("invalid_request", `invalid protected metadata path: ${path}`);
		}
	}
}

function preLaunchCancellation(): SandboxCancelledResult {
	return {
		status: "cancelled",
		backend: "none",
		exitCode: null,
		signal: null,
		stdout: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
	};
}

function preLaunchAbortError(): Error {
	const error = new Error("Sandbox process launch was aborted");
	error.name = "AbortError";
	return error;
}

async function materializeProtectedMetadataTargets(
	policy: Readonly<CompiledSandboxPolicy>,
): Promise<Readonly<CompiledSandboxPolicy>> {
	if (policy.writableRoots === "full-disk" || policy.protectedMetadataPaths.length === 0) return policy;
	const paths = new Set(policy.protectedMetadataPaths);
	for (const path of policy.protectedMetadataPaths) {
		try {
			paths.add(await realpath(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new SandboxExecutionError(
				"invalid_request",
				`Could not resolve protected metadata path before Sandbox launch: ${path}`,
				error,
			);
		}
	}
	if (paths.size === policy.protectedMetadataPaths.length) return policy;
	return Object.freeze({ ...policy, protectedMetadataPaths: Object.freeze([...paths]) });
}

class OutputCollector {
	readonly #limit: number;
	#retained = 0;
	#truncated = false;
	readonly #stdout: string[] = [];
	readonly #stderr: string[] = [];
	#diagnosticTail = "";

	constructor(limit: number) {
		this.#limit = limit;
	}

	add(channel: SandboxOutputChunk["channel"], text: string): void {
		this.#diagnosticTail = `${this.#diagnosticTail}${text}`.slice(-64 * 1024);
		const available = this.#limit - this.#retained;
		if (available <= 0) {
			this.#truncated = true;
			return;
		}
		const bytes = Buffer.from(text);
		const visible = bytes.byteLength <= available ? text : bytes.subarray(0, available).toString("utf8");
		this.#retained += Buffer.byteLength(visible);
		if (visible !== text) this.#truncated = true;
		(channel === "stdout" ? this.#stdout : this.#stderr).push(visible);
	}

	get stdout(): string {
		return this.#stdout.join("");
	}

	get stderr(): string {
		return this.#stderr.join("");
	}

	get truncated(): boolean {
		return this.#truncated;
	}

	get diagnosticTail(): string {
		return this.#diagnosticTail;
	}
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The complete process group may already have exited.
		}
	}
}

const DENIAL_KEYWORDS: ReadonlyArray<readonly [FileSystemDenialReason, string]> = [
	["operation_not_permitted", "operation not permitted"],
	["permission_denied", "permission denied"],
	["read_only_file_system", "read-only file system"],
	["policy_denied", "seccomp"],
	["policy_denied", "sandbox"],
	["policy_denied", "landlock"],
	["failed_to_write_file", "failed to write file"],
];

function deniedPath(text: string): string | undefined {
	const markers = [": operation not permitted", ": permission denied", ": read-only file system"];
	for (const line of text.split("\n")) {
		const lower = line.toLowerCase();
		for (const marker of markers) {
			const markerIndex = lower.indexOf(marker);
			if (markerIndex < 0) continue;
			const prefix = line.slice(0, markerIndex);
			const candidate = (prefix.lastIndexOf(": ") < 0 ? prefix : prefix.slice(prefix.lastIndexOf(": ") + 2))
				.trim()
				.replace(/^["']|["']$/g, "");
			if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) {
				return candidate;
			}
		}
	}
	return undefined;
}

function classifyViolation(
	backend: SandboxBackend,
	exitCode: number | null,
	stdout: string,
	stderr: string,
): SandboxViolation | undefined {
	if (backend === "none" || exitCode === 0) return undefined;
	for (const output of [stderr, stdout]) {
		const lower = output.toLowerCase();
		for (const [reason, keyword] of DENIAL_KEYWORDS) {
			if (!lower.includes(keyword)) continue;
			return Object.freeze({
				kind: "filesystem",
				backend: backend === "macos-seatbelt" ? "seatbelt" : "linux-sandbox",
				reason,
				path: deniedPath(output),
				outputSnippet: output.trim().slice(0, 512),
			});
		}
	}
	return undefined;
}

async function startValidatedProcess(
	request: SandboxStartRequest,
	callbacks: SandboxExecuteCallbacks,
): Promise<SandboxProcess> {
	if (request.signal?.aborted) throw preLaunchAbortError();
	const policy = await materializeProtectedMetadataTargets(request.policy);
	if (request.managedNetwork && policy.networkAccess !== "restricted") {
		throw new SandboxExecutionError(
			"invalid_request",
			"Managed network requires a restricted network Permission Profile",
		);
	}
	let networkViolation: NetworkSandboxViolation | undefined;
	let observerFailure: unknown;
	const managedProxy = request.managedNetwork
		? await startManagedNetworkProxy(
				request.managedNetwork,
				(violation) => {
					networkViolation = violation;
					try {
						callbacks.onViolation?.(violation);
					} catch (error) {
						observerFailure ??= error;
					}
				},
				process.platform === "linux"
					? { transport: "unix", bridgePort: LINUX_MANAGED_PROXY_PORT }
					: { transport: "tcp" },
			)
		: undefined;
	let backend: SandboxBackend = "none";
	let command = request.command;
	let platformCleanup: (() => Promise<void>) | undefined;
	try {
		if (
			policy.readAccess !== "full-disk" ||
			policy.writableRoots !== "full-disk" ||
			policy.deniedReadRoots.length > 0 ||
			policy.networkAccess === "restricted"
		) {
			if (process.platform === "darwin") {
				const prepared = prepareMacosSeatbelt(request.command, policy, {
					managedProxyPorts: managedProxy?.port === undefined ? [] : [managedProxy.port],
					runtimeReadPaths: isAbsolute(request.command[0]) ? [request.command[0]] : [],
				});
				if (!prepared) {
					throw new SandboxExecutionError(
						"backend_unavailable",
						`Required macOS Sandbox executable is unavailable at /usr/bin/sandbox-exec`,
					);
				}
				backend = prepared.backend;
				command = [prepared.executable, ...prepared.args];
			} else if (process.platform === "linux") {
				if (await isWsl1()) {
					throw new SandboxExecutionError(
						"unsupported_platform",
						"Linux bubblewrap Sandbox is unsupported on WSL1; use WSL2",
					);
				}
				const bwrap = await resolveLinuxBubblewrap({ cwd: request.cwd });
				if (!bwrap) {
					throw new SandboxExecutionError(
						"backend_unavailable",
						"Required Linux bubblewrap Sandbox is unavailable or cannot create user namespaces",
					);
				}
				const helper = await linuxHelperPath();
				const helperArgs: [string, ...string[]] = managedProxy?.socketPath
					? [helper, "--proxy-socket", managedProxy.socketPath, "--proxy-port", String(LINUX_MANAGED_PROXY_PORT)]
					: [helper];
				const prepared = await prepareLinuxBubblewrap(bwrap, request.command, request.cwd, policy, {
					isolateNetwork: policy.networkAccess === "restricted",
					helper: helperArgs,
				});
				backend = prepared.backend;
				command = [prepared.executable, ...prepared.args];
				platformCleanup = prepared.cleanup;
			} else {
				throw new SandboxExecutionError(
					"unsupported_platform",
					`Restricted Sandbox profiles are unsupported on ${process.platform}`,
				);
			}
		}
	} catch (error) {
		await platformCleanup?.();
		await managedProxy?.close();
		if (error instanceof SandboxExecutionError) throw error;
		throw new SandboxExecutionError("backend_unavailable", "Sandbox preparation failed closed", error);
	}
	if (request.signal?.aborted) {
		await platformCleanup?.();
		await managedProxy?.close();
		throw preLaunchAbortError();
	}

	const startedAt = Date.now();
	const [executable, ...args] = command;
	const child = spawn(executable, args, {
		cwd: request.cwd,
		env: { ...request.environment, ...managedProxy?.environment },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
		shell: false,
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	const output = new OutputCollector(request.maxOutputBytes ?? 4 * 1024 * 1024);
	let timedOut = false;
	let cancelled = false;
	let settled = false;
	let stdinClosed = false;
	let killTimer: NodeJS.Timeout | undefined;

	const terminate = (): void => {
		signalProcessTree(child.pid, "SIGTERM");
		killTimer ??= setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), CANCELLATION_TERMINATION_GRACE_MS);
		killTimer.unref();
	};
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") return;
		observerFailure ??= error;
		terminate();
	});
	const receive = (channel: SandboxOutputChunk["channel"], text: string): void => {
		output.add(channel, text);
		try {
			callbacks.onOutput?.(Object.freeze({ channel, text }));
		} catch (error) {
			observerFailure ??= error;
			terminate();
		}
	};
	child.stdout.on("data", (text: string) => receive("stdout", text));
	child.stderr.on("data", (text: string) => receive("stderr", text));

	const onAbort = (): void => {
		cancelled = true;
		terminate();
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		signalProcessTree(child.pid, "SIGKILL");
	}, request.timeoutMs);
	timeout.unref();

	const cleanup = (): void => {
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		request.signal?.removeEventListener("abort", onAbort);
	};
	const rawCompletion = new Promise<SandboxExecutionResult>((resolve, reject) => {
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new SandboxExecutionError("launch_failed", `Failed to launch ${executable}`, error));
		});
		child.once("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			// A shell can exit while TERM-ignoring descendants remain in its process group.
			// Always hard-kill any survivors before reporting execution complete.
			signalProcessTree(child.pid, "SIGKILL");
			if (observerFailure !== undefined) {
				reject(new SandboxExecutionError("observer_failed", "Sandbox output observer failed", observerFailure));
				return;
			}
			const collectedStdout = output.stdout;
			const collectedStderr = output.stderr;
			const denial =
				cancelled || timedOut
					? undefined
					: (networkViolation ??
						classifyViolation(
							backend,
							exitCode,
							`${collectedStdout}\n${output.diagnosticTail}`,
							`${collectedStderr}\n${output.diagnosticTail}`,
						));
			if (denial?.kind === "filesystem") {
				try {
					callbacks.onViolation?.(denial);
				} catch (error) {
					reject(new SandboxExecutionError("observer_failed", "Sandbox violation observer failed", error));
					return;
				}
			}
			const common = {
				backend,
				exitCode,
				signal,
				stdout: collectedStdout,
				stderr: collectedStderr,
				truncated: output.truncated,
				durationMs: Date.now() - startedAt,
			};
			if (denial) {
				resolve({ status: "denied", denial, ...common });
				return;
			}
			if (cancelled) {
				resolve({ status: "cancelled", ...common });
				return;
			}
			if (timedOut) {
				resolve({ status: "timed-out", ...common });
				return;
			}
			resolve({ status: "exited", ...common });
		});
	});
	const completion = rawCompletion.finally(async () => {
		await platformCleanup?.();
		await managedProxy?.close();
	});
	void completion.catch(() => undefined);

	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", (error) =>
			reject(new SandboxExecutionError("launch_failed", `Failed to launch ${executable}`, error)),
		);
	});
	try {
		await spawned;
	} catch (error) {
		await completion.catch(() => undefined);
		throw error;
	}

	const write = (input: string | Uint8Array): Promise<void> => {
		if (stdinClosed || settled || !child.stdin.writable) return Promise.reject(new Error("Process stdin is closed"));
		return new Promise<void>((resolve, reject) => {
			child.stdin.write(input, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	};
	const closeStdin = (input?: string | Uint8Array): Promise<void> => {
		if (stdinClosed || settled || !child.stdin.writable) return Promise.resolve();
		stdinClosed = true;
		return new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				child.stdin.off("error", onError);
				reject(error);
			};
			child.stdin.once("error", onError);
			child.stdin.end(input, () => {
				child.stdin.off("error", onError);
				resolve();
			});
		});
	};
	return Object.freeze({
		backend,
		completion,
		write,
		closeStdin,
		stop: () => {
			if (!settled) {
				cancelled = true;
				terminate();
			}
			return completion;
		},
	});
}

export async function startProcess(
	request: SandboxStartRequest,
	callbacks: SandboxExecuteCallbacks = {},
): Promise<SandboxProcess> {
	await validateRequest(request);
	return startValidatedProcess(request, callbacks);
}

export async function execute(
	request: SandboxExecuteRequest,
	callbacks: SandboxExecuteCallbacks = {},
): Promise<SandboxExecutionResult> {
	await validateRequest(request);
	if (request.signal?.aborted) return preLaunchCancellation();
	let processHandle: SandboxProcess;
	try {
		processHandle = await startValidatedProcess(request, callbacks);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return preLaunchCancellation();
		throw error;
	}
	try {
		await processHandle.closeStdin(request.stdin);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
	}
	return processHandle.completion;
}
