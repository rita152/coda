import { InMemoryCredentialStore } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { KeychainCredentialStore } from "../src/credentials/keychain-store.ts";
import { createNodeCredentialStore } from "../src/credentials/node-credential-store.ts";
import { SecretServiceCredentialStore } from "../src/credentials/secret-service-store.ts";
import {
	SecretToolClient,
	type SecretToolProcessRunner,
	type SecretToolRunRequest,
	type SecretToolRunResult,
} from "../src/credentials/secret-tool-client.ts";

const SERVICE = "coda.cli.credentials.v1";

interface RecordedRun {
	readonly args: readonly string[];
	readonly input: string | undefined;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function result(exitCode: number, stdout = "", stderr = ""): SecretToolRunResult {
	return { exitCode, stdout, stderr };
}

function attribute(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

function itemKey(args: readonly string[]): string {
	return `${attribute(args, "service")}:${attribute(args, "provider")}`;
}

class FakeSecretToolRunner implements SecretToolProcessRunner {
	readonly values = new Map<string, string>();
	readonly calls: RecordedRun[] = [];
	available = true;
	storeFailure: string | undefined;
	nextRun: ((request: SecretToolRunRequest) => Promise<SecretToolRunResult>) | undefined;

	async run(request: SecretToolRunRequest): Promise<SecretToolRunResult> {
		this.calls.push({ args: [...request.args], input: request.input });
		const nextRun = this.nextRun;
		this.nextRun = undefined;
		if (nextRun) return nextRun(request);
		request.signal?.throwIfAborted();
		if (!this.available) return result(1, "", "secret-tool: Secret Service is unavailable");
		switch (request.args[0]) {
			case "lookup": {
				const value = this.values.get(itemKey(request.args));
				return value === undefined ? result(1) : result(0, value);
			}
			case "store": {
				if (this.storeFailure !== undefined) return result(1, "", this.storeFailure);
				this.values.set(itemKey(request.args), request.input ?? "");
				return result(0);
			}
			case "clear":
				this.values.delete(itemKey(request.args));
				return result(0);
			default:
				return result(2, "", "unexpected command");
		}
	}
}

function createStore(runner: FakeSecretToolRunner, onUnavailable?: () => void): SecretServiceCredentialStore {
	return new SecretServiceCredentialStore(new SecretToolClient(runner), ["other-provider", "opencode-go"], {
		onUnavailable,
	});
}

async function caughtError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("Operation rejected with a non-Error value");
	}
	throw new Error("Operation unexpectedly succeeded");
}

describe("Linux Secret Service CredentialStore", () => {
	it("reads, lists, atomically updates, and deletes through secret-tool", async () => {
		const runner = new FakeSecretToolRunner();
		const store = createStore(runner);
		const firstSecret = "credential-test-first";
		const secondSecret = "credential-test-second";
		const thirdSecret = "credential-test-third";

		await store.modify("opencode-go", async () => ({ type: "api_key", key: firstSecret }));
		const stored = await store.read("opencode-go");
		expect(stored?.type === "api_key" && stored.key === firstSecret).toBe(true);
		await expect(store.list()).resolves.toEqual([{ providerId: "opencode-go", type: "api_key" }]);

		const entered = deferred<void>();
		const release = deferred<void>();
		const firstUpdate = store.modify("opencode-go", async (current) => {
			expect(current?.type === "api_key" && current.key === firstSecret).toBe(true);
			entered.resolve(undefined);
			await release.promise;
			return { type: "api_key", key: secondSecret };
		});
		await entered.promise;
		const secondUpdate = store.modify("opencode-go", async (current) => {
			expect(current?.type === "api_key" && current.key === secondSecret).toBe(true);
			return { type: "api_key", key: thirdSecret };
		});
		release.resolve(undefined);
		await Promise.all([firstUpdate, secondUpdate]);
		const updated = await store.read("opencode-go");
		expect(updated?.type === "api_key" && updated.key === thirdSecret).toBe(true);

		const storeCall = runner.calls.find((call) => call.args[0] === "store");
		expect(storeCall?.args.includes(firstSecret)).toBe(false);
		expect(storeCall?.input === JSON.stringify({ type: "api_key", key: firstSecret })).toBe(true);
		expect(storeCall?.args).toContain("--label=Coda Provider Credential");

		await store.delete("opencode-go");
		await expect(store.read("opencode-go")).resolves.toBeUndefined();
		expect(runner.values.has(`${SERVICE}:opencode-go`)).toBe(false);
	});

	it("rejects malformed stored values without exposing their contents", async () => {
		const runner = new FakeSecretToolRunner();
		const malformed = "malformed-credential-test-value";
		runner.values.set(`${SERVICE}:opencode-go`, malformed);
		const store = createStore(runner);

		const error = await caughtError(store.read("opencode-go"));

		expect(error.message).toBe('Stored Credential for "opencode-go" is not valid JSON');
		expect(error.message.includes(malformed)).toBe(false);
	});

	it("cancels an active lookup without leaking runner failures", async () => {
		const runner = new FakeSecretToolRunner();
		const store = createStore(runner);
		await store.list();
		const commandStarted = deferred<void>();
		const secret = "cancelled-runner-secret";
		runner.nextRun = (request) =>
			new Promise<SecretToolRunResult>((_resolve, reject) => {
				commandStarted.resolve(undefined);
				request.signal?.addEventListener("abort", () => reject(new Error(`runner included ${secret}`)), {
					once: true,
				});
			});
		const controller = new AbortController();

		const read = store.read("opencode-go", { signal: controller.signal });
		await commandStarted.promise;
		controller.abort();
		const error = await caughtError(read);

		expect(error.name).toBe("AbortError");
		expect(error.message.includes(secret)).toBe(false);
	});

	it("uses a reported process-local fallback when Secret Service is unavailable", async () => {
		const runner = new FakeSecretToolRunner();
		runner.available = false;
		let notices = 0;
		const store = createStore(runner, () => {
			notices += 1;
		});
		const secret = "process-local-test-secret";

		await store.modify("opencode-go", async () => ({ type: "api_key", key: secret }));
		const stored = await store.read("opencode-go");
		expect(stored?.type === "api_key" && stored.key === secret).toBe(true);
		await expect(store.list()).resolves.toEqual([{ providerId: "opencode-go", type: "api_key" }]);
		expect(notices).toBe(1);
		expect(runner.calls).toHaveLength(1);

		const nextProcessStore = createStore(runner);
		await expect(nextProcessStore.read("opencode-go")).resolves.toBeUndefined();
		expect(runner.values.size).toBe(0);
	});

	it("redacts secret-tool stderr and never places a Credential in argv", async () => {
		const runner = new FakeSecretToolRunner();
		const store = createStore(runner);
		await store.read("opencode-go");
		const secret = "stderr-redaction-test-secret";
		runner.storeFailure = `secret-tool echoed ${secret}`;

		const error = await caughtError(store.modify("opencode-go", async () => ({ type: "api_key", key: secret })));
		const failedStore = [...runner.calls].reverse().find((call) => call.args[0] === "store");

		expect(error.message).toBe("Linux Secret Service is unavailable");
		expect(error.message.includes(secret)).toBe(false);
		expect(error.cause).toBeUndefined();
		expect(failedStore?.args.includes(secret)).toBe(false);
		expect(failedStore?.input?.includes(secret)).toBe(true);
	});
});

describe("Node CredentialStore selection", () => {
	it("preserves macOS Keychain, selects Secret Service on Linux, and keeps other platforms process-local", async () => {
		const runner = new FakeSecretToolRunner();
		runner.available = false;
		let notices = 0;
		const linux = createNodeCredentialStore({
			platform: "linux",
			environment: {},
			providerIds: ["opencode-go"],
			secretToolRunner: runner,
			onSecretServiceUnavailable: () => {
				notices += 1;
			},
		});
		const macos = createNodeCredentialStore({
			platform: "darwin",
			environment: {},
			providerIds: ["opencode-go"],
		});
		const windows = createNodeCredentialStore({
			platform: "win32",
			environment: {},
			providerIds: ["opencode-go"],
		});

		expect(linux).toBeInstanceOf(SecretServiceCredentialStore);
		expect(macos).toBeInstanceOf(KeychainCredentialStore);
		expect(windows).toBeInstanceOf(InMemoryCredentialStore);
		await linux.list();
		expect(notices).toBe(1);
	});
});
