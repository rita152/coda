import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileSandboxPolicy, execute, PROTECTED_METADATA_NAMES } from "../src/index.ts";

const artifacts: string[] = [];

afterEach(async () => {
	await Promise.all(artifacts.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin")("macOS Sandbox", () => {
	it("enforces a deny-read carveout even when the base profile is Full Access", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-sandbox-deny-read-"));
		artifacts.push(fixture);
		const secret = join(fixture, "secret.txt");
		await writeFile(secret, "classified");
		const canonicalFixture = await realpath(fixture);
		const canonicalSecret = await realpath(secret);
		const base = compileSandboxPolicy({
			profile: "full-access",
			workspaceRoots: [canonicalFixture],
			temporaryDirectory: await realpath(tmpdir()),
		});
		const policy = Object.freeze({ ...base, deniedReadRoots: Object.freeze([canonicalSecret]) });

		const result = await execute({
			command: ["/bin/cat", secret],
			cwd: canonicalFixture,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({ status: "denied", backend: "macos-seatbelt" });
		expect(result.stdout).not.toContain("classified");
	});

	it("denies a descendant write outside every canonical Workspace root", async () => {
		const fixture = await mkdtemp(join(process.cwd(), ".sandbox-escape-"));
		artifacts.push(fixture);
		const workspace = join(fixture, "workspace");
		await mkdir(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const outside = join(fixture, "outside.txt");
		const canonicalTmp = await realpath(tmpdir());

		const result = await execute({
			command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", outside],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy: compileSandboxPolicy({
				profile: "workspace",
				workspaceRoots: [canonicalWorkspace],
				temporaryDirectory: canonicalTmp,
			}),
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({
			status: "denied",
			backend: "macos-seatbelt",
			denial: {
				kind: "filesystem",
				backend: "seatbelt",
				reason: "operation_not_permitted",
			},
		});
		expect(result.exitCode).not.toBe(0);
		await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("allows ordinary Workspace writes but denies protected metadata creation", async () => {
		const { canonicalTmp, canonicalWorkspace, workspace } = await fixtureWorkspace();
		const allowed = join(workspace, "allowed.txt");
		const protectedFile = join(workspace, ".coda", "forbidden.txt");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});

		const allowedResult = await execute({
			command: ["/bin/sh", "-c", 'printf allowed > "$1"', "coda-test", allowed],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(allowedResult).toMatchObject({ status: "exited", exitCode: 0 });
		await expect(readFile(allowed, "utf8")).resolves.toBe("allowed");

		const protectedResult = await execute({
			command: [
				"/bin/sh",
				"-c",
				'mkdir -p "$1" && printf denied > "$2"',
				"coda-test",
				join(workspace, ".coda"),
				protectedFile,
			],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(protectedResult).toMatchObject({ status: "denied" });
		await expect(access(protectedFile)).rejects.toMatchObject({ code: "ENOENT" });
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
		await expect(
			execute({
				command: [
					"/bin/sh",
					"-c",
					'mkdir -p "$(dirname "$1")" && printf escaped > "$1"',
					"coda-test",
					protectedFile,
				],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ status: "denied" });
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
		await expect(
			execute({
				command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", siblingFile],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ status: "denied" });
		await expect(readFile(reviewedFile, "utf8")).resolves.toBe("allowed");
		await expect(access(siblingFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("protects metadata reached through a symlink to another writable Workspace path", async () => {
		const { canonicalTmp, canonicalWorkspace, workspace } = await fixtureWorkspace();
		const metadataTarget = join(workspace, "git-metadata-target");
		const replacementTarget = join(workspace, "replacement-target");
		await mkdir(metadataTarget);
		await mkdir(replacementTarget);
		await symlink(metadataTarget, join(workspace, ".git"));
		const target = join(workspace, ".git", "config");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});

		const result = await execute({
			command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", target],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});

		expect(result.status).toBe("denied");
		const replacement = await execute({
			command: [
				"/bin/sh",
				"-c",
				'rm "$1" && ln -s "$2" "$1" && printf escaped > "$1/config"',
				"coda-test",
				join(workspace, ".git"),
				replacementTarget,
			],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		expect(replacement.status).toBe("denied");
		await expect(access(join(metadataTarget, "config"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(join(replacementTarget, "config"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("denies writes through a Workspace symlink and from a descendant process", async () => {
		const { canonicalTmp, canonicalWorkspace, fixture, workspace } = await fixtureWorkspace();
		const outsideDirectory = join(fixture, "outside");
		await mkdir(outsideDirectory);
		await symlink(outsideDirectory, join(workspace, "link"));
		const symlinkTarget = join(workspace, "link", "symlink.txt");
		const childTarget = join(fixture, "child.txt");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});

		const symlinkResult = await execute({
			command: ["/bin/sh", "-c", 'printf escaped > "$1"', "coda-test", symlinkTarget],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});
		const childResult = await execute({
			command: ["/bin/sh", "-c", '/bin/sh -c \'printf escaped > "$1"\' coda-child "$1"', "coda-test", childTarget],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 5_000,
		});

		expect(symlinkResult.status).toBe("denied");
		expect(childResult.status).toBe("denied");
		await expect(access(join(outsideDirectory, "symlink.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(childTarget)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("blocks direct network access under a restricted profile", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		let accepted = false;
		const server = createServer((socket) => {
			accepted = true;
			socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP server address");
		try {
			const result = await execute({
				command: ["/usr/bin/curl", "--silent", "--show-error", `http://127.0.0.1:${address.port}/`],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy: compileSandboxPolicy({
					profile: "read-only",
					workspaceRoots: [canonicalWorkspace],
					temporaryDirectory: canonicalTmp,
				}),
				timeoutMs: 5_000,
			});
			expect(result.exitCode).not.toBe(0);
			expect(accepted).toBe(false);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("routes managed network through host decisions and reports an exact blocked destination", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		let accepted = 0;
		const upstreamSockets = new Set<import("node:net").Socket>();
		const upstream = createServer((socket) => {
			upstreamSockets.add(socket);
			socket.once("close", () => upstreamSockets.delete(socket));
			accepted++;
			socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("expected TCP server address");
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		try {
			const denied = await execute({
				command: ["/usr/bin/curl", "--fail", "--silent", "--show-error", `http://127.0.0.1:${address.port}/`],
				cwd: canonicalWorkspace,
				environment: { PATH: "/usr/bin:/bin" },
				policy,
				timeoutMs: 5_000,
				managedNetwork: {
					environmentId: "local",
					decide: () => ({ action: "deny", source: "default", reason: "host requires approval" }),
				},
			});
			expect(denied).toMatchObject({
				status: "denied",
				denial: {
					kind: "network",
					host: "127.0.0.1",
					protocol: "http",
					port: address.port,
					decision: "deny",
					source: "default",
				},
			});
			expect(accepted).toBe(0);

			const allowed = await execute({
				command: ["/usr/bin/curl", "--fail", "--silent", "--show-error", `http://127.0.0.1:${address.port}/`],
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
			for (const socket of upstreamSockets) socket.destroy();
			await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("kills the process group on timeout and cancellation", async () => {
		const { canonicalTmp, canonicalWorkspace } = await fixtureWorkspace();
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [canonicalWorkspace],
			temporaryDirectory: canonicalTmp,
		});
		const timeoutMarker = join(canonicalTmp, `coda-macos-timeout-${process.pid}-${Date.now()}`);
		artifacts.push(timeoutMarker);
		const timedOut = await execute({
			command: ["/bin/sh", "-c", `(sleep 1; printf survived > "${timeoutMarker}") & wait`],
			cwd: canonicalWorkspace,
			environment: { PATH: "/usr/bin:/bin" },
			policy,
			timeoutMs: 100,
		});
		expect(timedOut.status).toBe("timed-out");

		const cancelMarker = join(canonicalTmp, `coda-macos-cancel-${process.pid}-${Date.now()}`);
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
	const fixture = await mkdtemp(join(process.cwd(), ".sandbox-fixture-"));
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
