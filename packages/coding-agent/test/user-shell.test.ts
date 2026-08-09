import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner, ProcessRunRequest } from "../src/host/process-runner.ts";
import { UserShell, type UserShellSnapshot } from "../src/interactive/user-shell.ts";

describe("UserShell", () => {
	it("uses a login Shell with the full environment and emits sanitized live output", async () => {
		let request: ProcessRunRequest | undefined;
		const updates: UserShellSnapshot[] = [];
		const processRunner: ProcessRunner = {
			run: async (candidate) => {
				request = candidate;
				candidate.onOutput?.({ channel: "stdout", text: "head\rnext\u001b]0;evil" });
				candidate.onOutput?.({ channel: "stderr", text: "\u0007safe\u202etext" });
				return {
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
				};
			},
		};
		let now = 10;
		const shell = new UserShell({
			processRunner,
			platform: "darwin",
			workspace: "/workspace",
			environment: { SHELL: "/bin/zsh", SECRET: "visible-to-explicit-shell", MISSING: undefined },
			clock: { now: () => now++ },
			onUpdate: (snapshot) => updates.push(snapshot),
		});

		const result = await shell.run("printf hello", "printf hello");

		expect(request).toMatchObject({
			executable: "/bin/zsh",
			args: ["-lc", "printf hello"],
			cwd: "/workspace",
			environment: { SHELL: "/bin/zsh", SECRET: "visible-to-explicit-shell" },
			timeoutMs: 3_600_000,
		});
		expect(request?.overflowPath).toBeUndefined();
		expect(updates.map(({ status }) => status)).toEqual(["running", "running", "running", "success"]);
		expect(result).toMatchObject({
			status: "success",
			output: "head\nnextsafetext",
			exitCode: 0,
			truncated: false,
		});
	});

	it("retains a bounded head and tail without writing an overflow transcript", async () => {
		const processRunner: ProcessRunner = {
			run: async (request) => {
				request.onOutput?.({ channel: "stdout", text: `HEAD${"a".repeat(60 * 1_024)}TAIL` });
				return {
					exitCode: 1,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: true,
				};
			},
		};
		const shell = new UserShell({
			processRunner,
			platform: "linux",
			workspace: "/workspace",
			environment: {},
			clock: { now: () => 10 },
			onUpdate: vi.fn(),
		});

		const result = await shell.run("shell:large", "large");

		expect(result.status).toBe("failed");
		expect(result.truncated).toBe(true);
		expect(result.output).toMatch(/^HEADa+/);
		expect(result.output).toContain("bytes omitted ...]");
		expect(result.output).toMatch(/a+TAIL$/);
		expect(Buffer.byteLength(result.output)).toBeLessThan(52 * 1_024);
	});

	it("falls back to /bin/sh when the configured absolute Shell is unavailable", async () => {
		const executables: string[] = [];
		const processRunner: ProcessRunner = {
			run: async (request) => {
				executables.push(request.executable);
				if (executables.length === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return {
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
				};
			},
		};
		const shell = new UserShell({
			processRunner,
			platform: "darwin",
			workspace: "/workspace",
			environment: { SHELL: "/missing/shell" },
			clock: { now: () => 10 },
			onUpdate: vi.fn(),
		});

		await expect(shell.run("shell:fallback", "true")).resolves.toMatchObject({ status: "success" });
		expect(executables).toEqual(["/missing/shell", "/bin/sh"]);
	});

	it("cancels the active process while preserving partial output", async () => {
		let observedAbort!: () => void;
		const processRunner: ProcessRunner = {
			run: (request) => {
				request.onOutput?.({ channel: "stdout", text: "partial" });
				return new Promise((_resolve, reject) => {
					observedAbort = () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					};
					request.signal.addEventListener("abort", observedAbort, { once: true });
				});
			},
		};
		const shell = new UserShell({
			processRunner,
			platform: "darwin",
			workspace: "/workspace",
			environment: {},
			clock: { now: () => 10 },
			onUpdate: vi.fn(),
		});

		const running = shell.run("shell:cancel", "wait");
		expect(shell.cancel()).toBe(true);

		await expect(running).resolves.toMatchObject({ status: "cancelled", output: "partial" });
		expect(shell.running).toBe(false);
	});

	it("returns a clear unsupported result on Windows without spawning", async () => {
		const run = vi.fn<ProcessRunner["run"]>();
		const shell = new UserShell({
			processRunner: { run },
			platform: "win32",
			workspace: "C:\\workspace",
			environment: {},
			clock: { now: () => 10 },
			onUpdate: vi.fn(),
		});

		await expect(shell.run("shell:windows", "dir")).resolves.toMatchObject({
			status: "unsupported",
			error: "Local Shell mode is currently supported on macOS and Unix only",
		});
		expect(run).not.toHaveBeenCalled();
	});
});
