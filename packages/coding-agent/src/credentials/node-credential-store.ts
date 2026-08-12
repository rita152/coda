import { type CredentialStore, InMemoryCredentialStore } from "@coda/ai";
import { KeychainCredentialStore } from "./keychain-store.ts";
import { MacOsKeychainClient } from "./macos-keychain-client.ts";
import { SecretServiceCredentialStore } from "./secret-service-store.ts";
import {
	createNodeSecretToolProcessRunner,
	SecretToolClient,
	type SecretToolProcessRunner,
} from "./secret-tool-client.ts";

export interface NodeCredentialStoreOptions {
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly providerIds: readonly string[];
	readonly secretToolRunner?: SecretToolProcessRunner;
	readonly onSecretServiceUnavailable?: () => void | Promise<void>;
}

/** Selects the secure host Credential Store without introducing a plaintext fallback. */
export function createNodeCredentialStore(options: NodeCredentialStoreOptions): CredentialStore {
	if (options.platform === "darwin") {
		return new KeychainCredentialStore(new MacOsKeychainClient(), options.providerIds);
	}
	if (options.platform === "linux") {
		const runner =
			options.secretToolRunner ?? createNodeSecretToolProcessRunner({ environment: options.environment });
		return new SecretServiceCredentialStore(new SecretToolClient(runner), options.providerIds, {
			onUnavailable: options.onSecretServiceUnavailable,
		});
	}
	return new InMemoryCredentialStore();
}
