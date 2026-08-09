import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileSandboxPolicy, execute, normalizeNetworkHost } from "../src/index.ts";

const canonicalTemporaryDirectory = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const fullAccess = compileSandboxPolicy({
	profile: "full-access",
	workspaceRoots: [canonicalTemporaryDirectory],
	temporaryDirectory: canonicalTemporaryDirectory,
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("execute", () => {
	it("normalizes exact DNS and IP hosts like the Codex network policy", () => {
		expect(normalizeNetworkHost(" EXAMPLE.com.:443 ")).toBe("example.com");
		expect(normalizeNetworkHost("[FE80::1%25en0]:8443")).toBe("fe80::1%25en0");
		expect(normalizeNetworkHost("2001:DB8::1")).toBe("2001:db8::1");
		expect(normalizeNetworkHost("EXAMPLE.com:notaport")).toBe("example.com:notaport");
		expect(normalizeNetworkHost("[FE80::1]:notaport")).toBe("[fe80::1]:notaport");
	});

	it("rejects a lexical root that traverses a symbolic link before launch", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-noncanonical-root-"));
		temporaryDirectories.push(fixture);
		const canonicalFixture = await realpath(fixture);
		const target = join(canonicalFixture, "target");
		const alias = join(canonicalFixture, "alias");
		await mkdir(target);
		await symlink(target, alias, "dir");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [alias],
			temporaryDirectory: canonicalTemporaryDirectory,
		});

		await expect(
			execute({
				command: ["/bin/true"],
				cwd: target,
				environment: {},
				policy,
				timeoutMs: 5_000,
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it.each([
		{ field: "empty command", override: { command: [] } },
		{ field: "NUL command argument", override: { command: ["/bin/true", "bad\0argument"] } },
		{ field: "non-string environment", override: { environment: { PATH: 42 } } },
		{ field: "malformed policy", override: { policy: { ...fullAccess, networkAccess: "unrestricted" } } },
		{
			field: "forged compiled policy",
			override: {
				policy: {
					profile: "full-access",
					readAccess: "full-disk",
					deniedReadRoots: [],
					writableRoots: "full-disk",
					protectedMetadataRoots: [],
					protectedMetadataNames: [],
					protectedMetadataPaths: [],
					networkAccess: "enabled",
				},
			},
		},
		{
			field: "incoherent Read Only policy",
			override: { policy: { ...fullAccess, profile: "read-only" } },
		},
		{
			field: "incoherent Full Access policy",
			override: { policy: { ...fullAccess, writableRoots: [] } },
		},
	])("fails closed on a malformed runtime $field", async ({ override }) => {
		await expect(
			execute({
				command: ["/bin/true"],
				cwd: canonicalTemporaryDirectory,
				environment: {},
				policy: fullAccess,
				timeoutMs: 5_000,
				...override,
			} as never),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("streams and returns a Full Access process result without an outer sandbox", async () => {
		const output: Array<readonly [string, string]> = [];
		const result = await execute(
			{
				command: ["/bin/sh", "-c", "printf out; printf err >&2"],
				cwd: canonicalTemporaryDirectory,
				environment: { PATH: "/usr/bin:/bin" },
				policy: fullAccess,
				timeoutMs: 5_000,
			},
			{
				onOutput: (chunk) => output.push([chunk.channel, chunk.text]),
			},
		);

		expect(result).toMatchObject({
			status: "exited",
			backend: "none",
			exitCode: 0,
			signal: null,
			stdout: "out",
			stderr: "err",
		});
		expect(output).toEqual([
			["stdout", "out"],
			["stderr", "err"],
		]);
	});

	it("delivers an explicit stdin payload and closes the stream", async () => {
		const result = await execute({
			command: [
				process.execPath,
				"-e",
				"let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(value.toUpperCase()))",
			],
			cwd: canonicalTemporaryDirectory,
			environment: {},
			policy: fullAccess,
			timeoutMs: 5_000,
			stdin: "exact payload",
		});

		expect(result).toMatchObject({ status: "exited", exitCode: 0, stdout: "EXACT PAYLOAD" });
	});

	it("returns typed timeout and pre-launch cancellation states", async () => {
		const timedOut = await execute({
			command: ["/bin/sh", "-c", "sleep 5"],
			cwd: canonicalTemporaryDirectory,
			environment: { PATH: "/usr/bin:/bin" },
			policy: fullAccess,
			timeoutMs: 25,
		});
		expect(timedOut).toMatchObject({ status: "timed-out", backend: "none" });

		const controller = new AbortController();
		controller.abort();
		const restricted = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalTemporaryDirectory],
			temporaryDirectory: canonicalTemporaryDirectory,
		});
		const cancelled = await execute({
			command: ["/bin/true"],
			cwd: canonicalTemporaryDirectory,
			environment: {},
			policy: restricted,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		expect(cancelled).toMatchObject({ status: "cancelled", backend: "none", exitCode: null, durationMs: 0 });
	});

	it("bounds retained output without dropping streamed chunks", async () => {
		let streamed = "";
		const result = await execute(
			{
				command: ["/bin/sh", "-c", "printf 1234567890"],
				cwd: canonicalTemporaryDirectory,
				environment: {},
				policy: fullAccess,
				timeoutMs: 5_000,
				maxOutputBytes: 4,
			},
			{
				onOutput: ({ text }) => {
					streamed += text;
				},
			},
		);

		expect(result).toMatchObject({ status: "exited", stdout: "1234", truncated: true });
		expect(streamed).toBe("1234567890");
	});

	it("fails with a typed observer error instead of leaving the child running", async () => {
		const pending = execute(
			{
				command: ["/bin/sh", "-c", "printf output; sleep 5"],
				cwd: canonicalTemporaryDirectory,
				environment: { PATH: "/usr/bin:/bin" },
				policy: fullAccess,
				timeoutMs: 10_000,
			},
			{
				onOutput: () => {
					throw new Error("observer exploded");
				},
			},
		);

		await expect(pending).rejects.toMatchObject({
			name: "SandboxExecutionError",
			code: "observer_failed",
		});
	});
});
