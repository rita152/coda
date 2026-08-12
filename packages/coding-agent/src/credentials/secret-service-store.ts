import {
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	InMemoryCredentialStore,
} from "@coda/ai";
import { type SystemCredentialClient, SystemCredentialStore } from "./system-credential-store.ts";

export interface SecretServiceClient extends SystemCredentialClient {
	isAvailable(options?: AuthOperationOptions): Promise<boolean>;
}

export interface SecretServiceCredentialStoreOptions {
	readonly fallback?: CredentialStore;
	readonly onUnavailable?: () => void | Promise<void>;
}

/** Chooses Linux Secret Service once, falling back only to process-local storage. */
export class SecretServiceCredentialStore implements CredentialStore {
	readonly #client: SecretServiceClient;
	readonly #persistent: CredentialStore;
	readonly #fallback: CredentialStore;
	readonly #onUnavailable: (() => void | Promise<void>) | undefined;
	#selected: CredentialStore | undefined;
	#reportedUnavailable = false;

	constructor(
		client: SecretServiceClient,
		providerIds: readonly string[],
		options: SecretServiceCredentialStoreOptions = {},
	) {
		this.#client = client;
		this.#persistent = new SystemCredentialStore(client, providerIds);
		this.#fallback = options.fallback ?? new InMemoryCredentialStore();
		this.#onUnavailable = options.onUnavailable;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.#store(options)).read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return (await this.#store(options)).list(options);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return (await this.#store(options)).modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await (await this.#store(options)).delete(providerId, options);
	}

	async #store(options?: AuthOperationOptions): Promise<CredentialStore> {
		if (this.#selected) return this.#selected;
		options?.signal?.throwIfAborted();
		const available = await this.#client.isAvailable(options);
		options?.signal?.throwIfAborted();
		this.#selected ??= available ? this.#persistent : this.#fallback;
		if (this.#selected === this.#fallback && !this.#reportedUnavailable) {
			this.#reportedUnavailable = true;
			await this.#onUnavailable?.();
		}
		return this.#selected;
	}
}
