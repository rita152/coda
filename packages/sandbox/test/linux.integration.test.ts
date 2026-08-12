import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileSandboxPolicy, execute, PROTECTED_METADATA_NAMES } from "../src/index.ts";
import { resolveLinuxBubblewrap } from "../src/linux-bubblewrap.ts";

const artifacts: string[] = [];

afterEach(async () => {
	await Promise.all(artifacts.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("Linux Sandbox", () => {
	it("enters the command with no capabilities and no_new_privs", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});

		const result = await execute({
			command: ["/bin/cat", "/proc/self/status"],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({ status: "exited", backend: "linux-bwrap", exitCode: 0 });
		expect(result.stdout).toMatch(/^CapEff:\s+0+$/mu);
		expect(result.stdout).toMatch(/^CapBnd:\s+0+$/mu);
		expect(result.stdout).toMatch(/^NoNewPrivs:\s+1$/mu);
	});

	it("enforces a denied read root without leaking its contents", async () => {
		const { canonicalTmp, canonicalWorkspace, fixture } = await fixtureWorkspace();
		const secret = join(fixture, "secret.txt");
		await writeFile(secret, "classified");
		const canonicalSecret = await realpath(secret);
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
			additionalReadableRoots: [fixture],
			deniedReadRoots: [canonicalSecret],
		});

		const result = await execute({
			command: ["/bin/cat", secret],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("classified");
	});

	it("keeps Full Access as an explicit read bypass", async () => {
		const { canonicalTmp, canonicalWorkspace, fixture } = await fixtureWorkspace();
		const secret = join(fixture, "secret.txt");
		await writeFile(secret, "classified");

		const result = await execute({
			command: ["/bin/cat", secret],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: [canonicalWorkspace],
				temporaryDirectory: canonicalTmp,
				deniedReadRoots: [await realpath(secret)],
			}),
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({ status: "exited", backend: "none", exitCode: 0 });
		expect(result.stdout).toBe("classified");
	});

	it("ships and verifies the current architecture's bubblewrap fallback", async () => {
		const bundled = fileURLToPath(new URL(`../resources/linux-${process.arch}/bwrap`, import.meta.url));
		await expect(
			resolveLinuxBubblewrap({
				cwd: process.cwd(),
				path: "/missing",
				bundledPath: bundled,
				probe: async (candidate) => candidate === (await realpath(bundled)),
			}),
		).resolves.toBe(await realpath(bundled));
	});

	it("allows Workspace writes and denies outside, protected-metadata, symlink, and child escapes", async () => {
		const { canonicalTmp, canonicalWorkspace, fixture, workspace } = await fixtureWorkspace();
		const outsideDirectory = join(fixture, "outside");
		await mkdir(outsideDirectory);
		await mkdir(join(workspace, ".git"));
		await symlink(outsideDirectory, join(workspace, "link"));
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		const allowed = join(workspace, "allowed.txt");
		const attempts = [
			join(fixture, "outside.txt"),
			join(workspace, ".git", "config"),
			join(workspace, ".coda", "state"),
			join(workspace, "link", "symlink.txt"),
		];

		const allowedResult = await execute({
			command: ["/bin/sh", "-c", 'printf allowed > "$1"', "coda-test", allowed],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(allowedResult).toMatchObject({ status: "exited", backend: "linux-bwrap", exitCode: 0 });
		expect(await readFile(allowed, "utf8")).toBe("allowed");

		for (const target of attempts) {
			const result = await execute({
				command: ["/bin/sh", "-c", 'mkdir -p "$(dirname "$1")" && printf escaped > "$1"', "coda-test", target],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			});
			expect(result.exitCode).not.toBe(0);
		}
		const childTarget = join(fixture, "child.txt");
		const child = await execute({
			command: ["/bin/sh", "-c", '/bin/sh -c \'printf escaped > "$1"\' coda-child "$1"', "coda-test", childTarget],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(child.exitCode).not.toBe(0);
		for (const target of [attempts[0]!, join(outsideDirectory, "symlink.txt"), childTarget]) {
			await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
		}
		for (const name of [".coda", ".agents", ".codex"]) {
			await expect(access(join(workspace, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("protects metadata below an explicitly configured additional root", async () => {
		const { canonicalTmp, canonicalWorkspace, fixture } = await fixtureWorkspace();
		const additionalRoot = join(fixture, "additional");
		await mkdir(additionalRoot);
		const canonicalAdditionalRoot = await realpath(additionalRoot);
		const allowed = join(additionalRoot, "allowed.txt");
		const protectedFile = join(additionalRoot, ".git", "config");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
			additionalWritableRoots: [canonicalAdditionalRoot],
		});

		await expect(
			execute({
				command: ["/bin/sh", "-c", 'printf allowed > "$1"', "coda-test", allowed],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ status: "exited", exitCode: 0 });
		const protectedResult = await execute({
			command: ["/bin/sh", "-c", 'mkdir -p "$(dirname "$1")" && printf escaped > "$1"', "coda-test", protectedFile],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(protectedResult.exitCode).not.toBe(0);
		await expect(readFile(allowed, "utf8")).resolves.toBe("allowed");
		await expect(access(protectedFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reopens only a more specific reviewed subtree inside protected metadata", async () => {
		const { canonicalTmp, canonicalWorkspace, workspace } = await fixtureWorkspace();
		const protectedRoot = join(workspace, ".git");
		const reviewedRoot = join(protectedRoot, "reviewed");
		await mkdir(reviewedRoot, { recursive: true });
		const canonicalReviewedRoot = await realpath(reviewedRoot);
		const base = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		if (base.writableRoots === "full-disk") throw new Error("Workspace must have restricted writes");
		const policy = Object.freeze({
			...base,
			writableRoots: Object.freeze([...base.writableRoots, canonicalReviewedRoot]),
			protectedMetadataRoots: Object.freeze([...base.protectedMetadataRoots, canonicalReviewedRoot]),
			protectedMetadataPaths: Object.freeze([
				...base.protectedMetadataPaths,
				...PROTECTED_METADATA_NAMES.map((name) => join(canonicalReviewedRoot, name)),
			]),
		});
		const reviewedFile = join(reviewedRoot, "allowed.txt");
		const siblingFile = join(protectedRoot, "still-denied.txt");

		await expect(
			execute({
				command: ["/bin/sh", "-c", 'printf allowed > "$1"', "coda-test", reviewedFile],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ status: "exited", exitCode: 0 });
		const denied = await execute({
			command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", siblingFile],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(denied.exitCode).not.toBe(0);
		await expect(readFile(reviewedFile, "utf8")).resolves.toBe("allowed");
		await expect(access(siblingFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("protects metadata reached through a symlink to another writable Workspace path", async () => {
		const { canonicalTmp, canonicalWorkspace, workspace } = await fixtureWorkspace();
		const metadataTarget = join(workspace, "git-metadata-target");
		await mkdir(metadataTarget);
		await symlink(metadataTarget, join(workspace, ".git"));
		const target = join(workspace, ".git", "config");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});

		await expect(
			execute({
				command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", target],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			}),
		).rejects.toMatchObject({
			code: "backend_unavailable",
			cause: expect.objectContaining({ message: expect.stringContaining("replaceable writable symlink") }),
		});
		await expect(access(join(metadataTarget, "config"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("blocks direct network and routes only reviewed HTTP destinations through the managed bridge", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		let accepted = 0;
		const sockets = new Set<Socket>();
		const upstream = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			accepted++;
			socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("expected TCP server address");
		const target = `http://127.0.0.1:${address.port}/`;
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		try {
			const direct = await execute({
				command: ["/usr/bin/curl", "--silent", "--show-error", target],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			});
			expect(direct.exitCode).not.toBe(0);
			expect(accepted).toBe(0);

			const denied = await execute({
				command: ["/usr/bin/curl", "--fail", "--silent", "--show-error", target],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
				managedNetwork: {
					environmentId: "local",
					decide: () => ({ action: "deny", source: "test", reason: "review required" }),
				},
			});
			expect(denied).toMatchObject({
				status: "denied",
				denial: { kind: "network", host: "127.0.0.1", protocol: "http", port: address.port },
			});
			expect(accepted).toBe(0);

			const allowed = await execute({
				command: ["/usr/bin/curl", "--fail", "--silent", "--show-error", target],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
				managedNetwork: {
					environmentId: "local",
					decide: () => ({ action: "allow", source: "session" }),
				},
			});
			expect(allowed).toMatchObject({ status: "exited", exitCode: 0, stdout: "ok" });
			expect(accepted).toBe(1);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("kills the complete process tree on timeout and cancellation", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		const timeoutMarker = join(canonicalTmp, `coda-timeout-${process.pid}-${Date.now()}`);
		artifacts.push(timeoutMarker);
		const timedOut = await execute({
			command: ["/bin/sh", "-c", `(sleep 1; printf survived > "${timeoutMarker}") & wait`],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 100,
		});
		expect(timedOut.status).toBe("timed-out");

		const cancelMarker = join(canonicalTmp, `coda-cancel-${process.pid}-${Date.now()}`);
		artifacts.push(cancelMarker);
		const controller = new AbortController();
		const pending = execute({
			command: [
				"/bin/sh",
				"-c",
				`(trap '' TERM; sleep 1; printf survived > "${cancelMarker}") & trap 'exit 0' TERM; while :; do sleep 1; done`,
			],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100).unref();
		await expect(pending).resolves.toMatchObject({ status: "cancelled" });
		await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
		await expect(access(timeoutMarker)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(cancelMarker)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

async function fixtureWorkspace(): Promise<{
	readonly fixture: string;
	readonly workspace: string;
	readonly canonicalWorkspace: string;
	readonly canonicalTmp: string;
}> {
	const fixture = await mkdtemp(join(process.cwd(), ".linux-sandbox-fixture-"));
	artifacts.push(fixture);
	const workspace = join(fixture, "workspace");
	await mkdir(workspace);
	return {
		fixture,
		workspace,
		canonicalWorkspace: await realpath(workspace),
		canonicalTmp: await realpath(tmpdir()),
	};
}
