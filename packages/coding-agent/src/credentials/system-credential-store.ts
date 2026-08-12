import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@coda/ai";

export const CODA_CREDENTIAL_SERVICE = "coda.cli.credentials.v1";

export interface SystemCredentialClient {
	read(service: string, account: string, options?: AuthOperationOptions): Promise<string | undefined>;
	write(service: string, account: string, secret: string, options?: AuthOperationOptions): Promise<void>;
	delete(service: string, account: string, options?: AuthOperationOptions): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialFromJson(providerId: string, value: string): Credential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`Stored Credential for "${providerId}" is not valid JSON`);
	}
	if (!isRecord(parsed)) throw new Error(`Stored Credential for "${providerId}" is invalid`);
	if (parsed.type === "api_key") {
		if (parsed.key !== undefined && typeof parsed.key !== "string") {
			throw new Error(`Stored API-key Credential for "${providerId}" is invalid`);
		}
		if (
			parsed.env !== undefined &&
			(!isRecord(parsed.env) || Object.values(parsed.env).some((entry) => typeof entry !== "string"))
		) {
			throw new Error(`Stored API-key Credential environment for "${providerId}" is invalid`);
		}
		return structuredClone(parsed) as unknown as Credential;
	}
	if (
		parsed.type === "oauth" &&
		typeof parsed.refresh === "string" &&
		typeof parsed.access === "string" &&
		typeof parsed.expires === "number" &&
		Number.isFinite(parsed.expires)
	) {
		return structuredClone(parsed) as unknown as Credential;
	}
	throw new Error(`Stored Credential for "${providerId}" has an unsupported shape`);
}

/** Serializes and coordinates one operating-system credential backend. */
export class SystemCredentialStore implements CredentialStore {
	readonly #client: SystemCredentialClient;
	readonly #providerIds: readonly string[];
	readonly #tails = new Map<string, Promise<unknown>>();

	constructor(client: SystemCredentialClient, providerIds: readonly string[]) {
		this.#client = client;
		this.#providerIds = Object.freeze([...new Set(providerIds)].sort());
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const value = await this.#client.read(CODA_CREDENTIAL_SERVICE, providerId, options);
		options?.signal?.throwIfAborted();
		return value === undefined ? undefined : credentialFromJson(providerId, value);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const values: CredentialInfo[] = [];
		for (const providerId of this.#providerIds) {
			const credential = await this.read(providerId, options);
			if (credential) values.push({ providerId, type: credential.type });
		}
		return values;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const previous = this.#tails.get(providerId) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				options?.signal?.throwIfAborted();
				const before = await this.read(providerId, options);
				const next = await fn(before === undefined ? undefined : structuredClone(before));
				options?.signal?.throwIfAborted();
				if (next === undefined) {
					await this.#client.delete(CODA_CREDENTIAL_SERVICE, providerId, options);
					return undefined;
				}
				const validated = credentialFromJson(providerId, JSON.stringify(next));
				await this.#client.write(CODA_CREDENTIAL_SERVICE, providerId, JSON.stringify(validated), options);
				return structuredClone(validated);
			});
		this.#tails.set(providerId, current);
		return current.finally(() => {
			if (this.#tails.get(providerId) === current) this.#tails.delete(providerId);
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.modify(providerId, async () => undefined, options);
	}
}
