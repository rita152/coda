import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutex } from "../../src/host/file-mutex.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";

const temporaryDirectories: string[] = [];

interface Deferred<Value = void> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
}

function deferred<Value = void>(): Deferred<Value> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-file-mutex-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function exitedProcessId(): Promise<number> {
	const child = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("Test process did not start");
	await once(child, "exit");
	return pid;
}

async function writeExitedOwner(path: string): Promise<void> {
	await writeFile(
		path,
		`${JSON.stringify({ version: 1, token: "exited-owner", pid: await exitedProcessId(), acquiredAt: 1 })}\n`,
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("file mutex", () => {
	it("serializes ordinary callers", async () => {
		const path = join(await temporaryDirectory(), "state.lock");
		const base = createNodeFileSystem();
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const secondObservedOwner = deferred();
		const entries: string[] = [];
		const first = withFileMutex({
			fileSystem: base,
			path,
			operation: async () => {
				entries.push("first");
				firstEntered.resolve();
				await releaseFirst.promise;
			},
		});
		await firstEntered.promise;
		const second = withFileMutex({
			fileSystem: {
				...base,
				readFile: async (candidate) => {
					const bytes = await base.readFile(candidate);
					if (candidate === path) secondObservedOwner.resolve();
					return bytes;
				},
			},
			path,
			operation: async () => {
				entries.push("second");
			},
		});

		await secondObservedOwner.promise;
		expect(entries).toEqual(["first"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(entries).toEqual(["first", "second"]);
	});

	it("lets an AbortSignal stop a waiter without disturbing the owner", async () => {
		const path = join(await temporaryDirectory(), "state.lock");
		const base = createNodeFileSystem();
		const ownerEntered = deferred();
		const releaseOwner = deferred();
		const waiterObservedOwner = deferred();
		const owner = withFileMutex({
			fileSystem: base,
			path,
			operation: async () => {
				ownerEntered.resolve();
				await releaseOwner.promise;
				return "owner-result";
			},
		});
		await ownerEntered.promise;
		const controller = new AbortController();
		const reason = new Error("stop waiting");
		const waiter = withFileMutex({
			fileSystem: {
				...base,
				readFile: async (candidate) => {
					const bytes = await base.readFile(candidate);
					if (candidate === path) waiterObservedOwner.resolve();
					return bytes;
				},
			},
			path,
			signal: controller.signal,
			operation: async () => "waiter-result",
		});

		await waiterObservedOwner.promise;
		controller.abort(reason);
		await expect(waiter).rejects.toBe(reason);
		releaseOwner.resolve();

		await expect(owner).resolves.toBe("owner-result");
	});

	it("times out a waiter without disturbing the owner", async () => {
		const path = join(await temporaryDirectory(), "state.lock");
		const fileSystem = createNodeFileSystem();
		const ownerEntered = deferred();
		const releaseOwner = deferred();
		const owner = withFileMutex({
			fileSystem,
			path,
			operation: async () => {
				ownerEntered.resolve();
				await releaseOwner.promise;
			},
		});
		await ownerEntered.promise;

		await expect(withFileMutex({ fileSystem, path, timeoutMs: 0, operation: async () => undefined })).rejects.toThrow(
			`Timed out acquiring file mutex: ${path}`,
		);
		releaseOwner.resolve();
		await owner;
	});

	it("rejects a non-regular mutex path without entering the operation", async () => {
		const path = join(await temporaryDirectory(), "state.lock");
		await mkdir(path);
		let entered = false;

		await expect(
			withFileMutex({
				fileSystem: createNodeFileSystem(),
				path,
				operation: async () => {
					entered = true;
				},
			}),
		).rejects.toThrow(`File mutex path must be a regular file: ${path}`);
		expect(entered).toBe(false);
	});

	it("does not let a stale observer retire a newer owner", async () => {
		const path = join(await temporaryDirectory(), "state.lock");
		await writeExitedOwner(path);
		const base = createNodeFileSystem();
		const staleRead = deferred();
		const releaseStaleRead = deferred();
		const staleObserverSawCurrentOwner = deferred();
		const staleObserverEntered = deferred();
		const newerOwnerEntered = deferred();
		const releaseNewerOwner = deferred();
		let staleObserverReads = 0;
		let inside = 0;
		let maximumInside = 0;
		const entryOrder: string[] = [];
		const staleObserver = withFileMutex({
			fileSystem: {
				...base,
				readFile: async (candidate) => {
					const bytes = await base.readFile(candidate);
					if (candidate !== path) return bytes;
					staleObserverReads++;
					if (staleObserverReads === 1) {
						staleRead.resolve();
						await releaseStaleRead.promise;
					} else {
						staleObserverSawCurrentOwner.resolve();
					}
					return bytes;
				},
			},
			path,
			operation: async () => {
				inside++;
				maximumInside = Math.max(maximumInside, inside);
				entryOrder.push("stale-observer");
				staleObserverEntered.resolve();
				inside--;
			},
		});
		await staleRead.promise;
		const newerOwner = withFileMutex({
			fileSystem: base,
			path,
			operation: async () => {
				inside++;
				maximumInside = Math.max(maximumInside, inside);
				entryOrder.push("newer-owner");
				newerOwnerEntered.resolve();
				await releaseNewerOwner.promise;
				inside--;
			},
		});
		await newerOwnerEntered.promise;
		releaseStaleRead.resolve();

		const firstProgress = await Promise.race([
			staleObserverEntered.promise.then(() => "entered-operation" as const),
			staleObserverSawCurrentOwner.promise.then(() => "observed-current-owner" as const),
		]);
		releaseNewerOwner.resolve();
		await Promise.all([staleObserver, newerOwner]);

		expect(firstProgress).toBe("observed-current-owner");
		expect(maximumInside).toBe(1);
		expect(entryOrder).toEqual(["newer-owner", "stale-observer"]);
	});

	it("keeps recovery bookkeeping isolated from overlapping mutex names and ordinary sibling files", async () => {
		const directory = await temporaryDirectory();
		const firstPath = join(directory, "state.lock");
		const overlappingPath = join(directory, "state.lock.recovery-decoy");
		const ordinarySibling = join(directory, "state.lock.recovery-ordinary");
		const base = createNodeFileSystem();
		const ownerEntered = deferred();
		const releaseOwner = deferred();
		const waiterObservedOwner = deferred();
		const waiterEntered = deferred();
		let insideOverlappingMutex = 0;
		let maximumInsideOverlappingMutex = 0;
		const owner = withFileMutex({
			fileSystem: base,
			path: overlappingPath,
			operation: async () => {
				insideOverlappingMutex++;
				maximumInsideOverlappingMutex = Math.max(maximumInsideOverlappingMutex, insideOverlappingMutex);
				ownerEntered.resolve();
				await releaseOwner.promise;
				insideOverlappingMutex--;
			},
		});
		await ownerEntered.promise;
		const old = new Date(Date.now() - 60_000);
		await utimes(overlappingPath, old, old);
		await writeFile(ordinarySibling, "ordinary sibling\n");
		await utimes(ordinarySibling, old, old);

		await withFileMutex({ fileSystem: base, path: firstPath, operation: async () => undefined });
		const waiter = withFileMutex({
			fileSystem: {
				...base,
				readFile: async (candidate) => {
					const bytes = await base.readFile(candidate);
					if (candidate === overlappingPath) waiterObservedOwner.resolve();
					return bytes;
				},
			},
			path: overlappingPath,
			operation: async () => {
				insideOverlappingMutex++;
				maximumInsideOverlappingMutex = Math.max(maximumInsideOverlappingMutex, insideOverlappingMutex);
				waiterEntered.resolve();
				insideOverlappingMutex--;
			},
		});
		const firstProgress = await Promise.race([
			waiterEntered.promise.then(() => "entered-operation" as const),
			waiterObservedOwner.promise.then(() => "observed-owner" as const),
		]);
		releaseOwner.resolve();
		await Promise.all([owner, waiter]);

		expect(firstProgress).toBe("observed-owner");
		expect(maximumInsideOverlappingMutex).toBe(1);
		expect(await readFile(ordinarySibling, "utf8")).toBe("ordinary sibling\n");
	});
});
