import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AuthOperationOptions } from "@coda/ai";
import type { SecretServiceClient } from "./secret-service-store.ts";

const SECRET_TOOL = "secret-tool";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 8 * 1024 - 1;
const APPLICATION_ATTRIBUTE = "application";
const APPLICATION_ATTRIBUTE_VALUE = "coda";
const SERVICE_ATTRIBUTE = "service";
const PROVIDER_ATTRIBUTE = "provider";
const PROBE_SERVICE = "coda.cli.credentials.probe.v1";
const PROBE_ACCOUNT = "availability";

export interface SecretToolRunRequest {
	readonly args: readonly string[];
	readonly input?: string;
	readonly signal?: AbortSignal;
}

export interface SecretToolRunResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface SecretToolProcessRunner {
	run(request: SecretToolRunRequest): Promise<SecretToolRunResult>;
}

export interface NodeSecretToolProcessRunnerOptions {
	readonly executable?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

class SecretServiceUnavailableError extends Error {
	constructor() {
		super("Linux Secret Service is unavailable");
		this.name = "SecretServiceUnavailableError";
	}
}

function abortError(): Error {
	const error = new Error("Credential operation was aborted");
	error.name = "AbortError";
	return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function boundedEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	const allowed = [
		"DBUS_SESSION_BUS_ADDRESS",
		"DESKTOP_SESSION",
		"DISPLAY",
		"GNOME_KEYRING_CONTROL",
		"HOME",
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LC_CTYPE",
		"LC_MESSAGES",
		"PATH",
		"USER",
		"WAYLAND_DISPLAY",
		"XAUTHORITY",
		"XDG_CURRENT_DESKTOP",
		"XDG_RUNTIME_DIR",
		"XDG_SESSION_TYPE",
	] as const;
	const result: Record<string, string> = {};
	for (const name of allowed) {
		const value = environment[name];
		if (value !== undefined) result[name] = value;
	}
	return Object.freeze(result);
}

export function createNodeSecretToolProcessRunner(
	options: NodeSecretToolProcessRunnerOptions = {},
): SecretToolProcessRunner {
	const executable = options.executable ?? SECRET_TOOL;
	const environment = boundedEnvironment(options.environment ?? process.env);
	return {
		run: (request) => {
			request.signal?.throwIfAborted();
			return new Promise<SecretToolRunResult>((resolve, reject) => {
				const child = spawn(executable, [...request.args], {
					env: { ...environment },
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
					signal: request.signal,
				}) as ChildProcessWithoutNullStreams;
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let outputBytes = 0;
				let settled = false;

				const fail = (error: unknown): void => {
					if (settled) return;
					settled = true;
					child.kill("SIGKILL");
					reject(error);
				};
				const receive = (output: Buffer[], chunk: Buffer): void => {
					outputBytes += chunk.byteLength;
					if (outputBytes > MAX_OUTPUT_BYTES) {
						fail(new Error("secret-tool returned an unexpectedly large response"));
						return;
					}
					output.push(chunk);
				};

				child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
				child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
				child.stdin.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code !== "EPIPE") fail(error);
				});
				child.once("error", fail);
				child.once("close", (exitCode) => {
					if (settled) return;
					settled = true;
					resolve({
						exitCode,
						stdout: Buffer.concat(stdout).toString("utf8"),
						stderr: Buffer.concat(stderr).toString("utf8"),
					});
				});
				child.stdin.end(request.input);
			});
		},
	};
}

function attributes(service: string, account: string): readonly string[] {
	return [APPLICATION_ATTRIBUTE, APPLICATION_ATTRIBUTE_VALUE, SERVICE_ATTRIBUTE, service, PROVIDER_ATTRIBUTE, account];
}

/** Maps Coda's credential client seam to libsecret's standard secret-tool CLI. */
export class SecretToolClient implements SecretServiceClient {
	readonly #runner: SecretToolProcessRunner;

	constructor(runner: SecretToolProcessRunner) {
		this.#runner = runner;
	}

	async isAvailable(options?: AuthOperationOptions): Promise<boolean> {
		let result: SecretToolRunResult;
		try {
			result = await this.#run(["lookup", "--", ...attributes(PROBE_SERVICE, PROBE_ACCOUNT)], undefined, options);
		} catch (error) {
			if (isAbort(error, options?.signal)) throw abortError();
			return false;
		}
		return result.exitCode === 0 || (result.exitCode === 1 && result.stderr.length === 0);
	}

	async read(service: string, account: string, options?: AuthOperationOptions): Promise<string | undefined> {
		const result = await this.#run(["lookup", "--", ...attributes(service, account)], undefined, options);
		if (result.exitCode === 0) return result.stdout;
		if (result.exitCode === 1 && result.stderr.length === 0) return undefined;
		throw result.exitCode === 1
			? new SecretServiceUnavailableError()
			: new Error(`Could not read Credential from Linux Secret Service (exit ${result.exitCode ?? "unknown"})`);
	}

	async write(service: string, account: string, secret: string, options?: AuthOperationOptions): Promise<void> {
		if (Buffer.byteLength(secret) > MAX_SECRET_BYTES) {
			throw new Error("Credential is too large for Linux Secret Service");
		}
		const result = await this.#run(
			["store", "--label=Coda Provider Credential", "--", ...attributes(service, account)],
			secret,
			options,
		);
		if (result.exitCode === 0) return;
		throw result.exitCode === 1
			? new SecretServiceUnavailableError()
			: new Error(`Could not save Credential to Linux Secret Service (exit ${result.exitCode ?? "unknown"})`);
	}

	async delete(service: string, account: string, options?: AuthOperationOptions): Promise<void> {
		const result = await this.#run(["clear", "--", ...attributes(service, account)], undefined, options);
		if (result.exitCode === 0 || (result.exitCode === 1 && result.stderr.length === 0)) return;
		throw result.exitCode === 1
			? new SecretServiceUnavailableError()
			: new Error(`Could not delete Credential from Linux Secret Service (exit ${result.exitCode ?? "unknown"})`);
	}

	async #run(
		args: readonly string[],
		input: string | undefined,
		options?: AuthOperationOptions,
	): Promise<SecretToolRunResult> {
		options?.signal?.throwIfAborted();
		try {
			const result = await this.#runner.run({
				args,
				...(input === undefined ? {} : { input }),
				signal: options?.signal,
			});
			options?.signal?.throwIfAborted();
			return result;
		} catch (error) {
			if (isAbort(error, options?.signal)) throw abortError();
			throw new SecretServiceUnavailableError();
		}
	}
}
