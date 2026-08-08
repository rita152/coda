import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AuthOperationOptions } from "@coda/ai";
import type { KeychainClient } from "./keychain-store.ts";

const SECURITY = "/usr/bin/security";
const NOT_FOUND_EXIT_CODE = 44;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface SecurityResult {
	readonly exitCode: number | null;
	readonly stdout: string;
}

function runSecurity(
	args: readonly string[],
	input: string | undefined,
	options?: AuthOperationOptions,
): Promise<SecurityResult> {
	options?.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(SECURITY, [...args], {
			stdio: ["pipe", "pipe", "pipe"],
			signal: options?.signal,
		}) as ChildProcessWithoutNullStreams;
		const output: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				return;
			}
			output.push(chunk);
		});
		child.stderr.resume();
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				reject(new Error("macOS Keychain returned an unexpectedly large response"));
				return;
			}
			resolve({ exitCode, stdout: Buffer.concat(output).toString("utf8") });
		});
		child.stdin.end(input === undefined ? undefined : `${input}\n`);
	});
}

export class MacOsKeychainClient implements KeychainClient {
	async read(service: string, account: string, options?: AuthOperationOptions): Promise<string | undefined> {
		const result = await runSecurity(
			["find-generic-password", "-s", service, "-a", account, "-w"],
			undefined,
			options,
		);
		if (result.exitCode === NOT_FOUND_EXIT_CODE) return undefined;
		if (result.exitCode !== 0)
			throw new Error(`Could not read Credential from macOS Keychain (exit ${result.exitCode})`);
		return result.stdout.replace(/\r?\n$/, "");
	}

	async write(service: string, account: string, secret: string, options?: AuthOperationOptions): Promise<void> {
		const result = await runSecurity(
			["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
			secret,
			options,
		);
		if (result.exitCode !== 0)
			throw new Error(`Could not save Credential to macOS Keychain (exit ${result.exitCode})`);
	}

	async delete(service: string, account: string, options?: AuthOperationOptions): Promise<void> {
		const result = await runSecurity(["delete-generic-password", "-s", service, "-a", account], undefined, options);
		if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND_EXIT_CODE) {
			throw new Error(`Could not delete Credential from macOS Keychain (exit ${result.exitCode})`);
		}
	}
}
