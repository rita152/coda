import { describe, expect, it } from "vitest";
import { type KeychainClient, KeychainCredentialStore } from "../src/credentials/keychain-store.ts";

class MemoryKeychain implements KeychainClient {
	readonly values = new Map<string, string>();

	read(service: string, account: string): Promise<string | undefined> {
		return Promise.resolve(this.values.get(`${service}:${account}`));
	}

	write(service: string, account: string, secret: string): Promise<void> {
		this.values.set(`${service}:${account}`, secret);
		return Promise.resolve();
	}

	delete(service: string, account: string): Promise<void> {
		this.values.delete(`${service}:${account}`);
		return Promise.resolve();
	}
}

describe("macOS Keychain CredentialStore", () => {
	it("serializes provider-scoped Credentials only into the injected Keychain client", async () => {
		const keychain = new MemoryKeychain();
		const store = new KeychainCredentialStore(keychain, ["opencode-go"]);

		await store.modify("opencode-go", async () => ({ type: "api_key", key: "secret-value" }));

		await expect(store.read("opencode-go")).resolves.toEqual({ type: "api_key", key: "secret-value" });
		await expect(store.list()).resolves.toEqual([{ providerId: "opencode-go", type: "api_key" }]);
		expect(keychain.values.get("coda.cli.credentials.v1:opencode-go")).toBe(
			'{"type":"api_key","key":"secret-value"}',
		);

		await store.delete("opencode-go");
		await expect(store.read("opencode-go")).resolves.toBeUndefined();
	});
});
