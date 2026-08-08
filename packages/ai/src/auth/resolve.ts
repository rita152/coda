// Portions derived from Pi:
// /packages/ai/src/auth/resolve.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { operationSignal, raceWithAbortSignal } from "../abort.ts";
import { ModelsError } from "../errors.ts";
import type { Clock, ProviderEnv } from "../types.ts";
import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
	clock?: Clock;
}

export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides & { clock: Clock },
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides.signal);
	return raceWithAbortSignal(resolveWithSignal(provider, credentials, authContext, overrides, signal), signal);
}

async function resolveWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides & { clock: Clock },
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestContext = overrides.env ? overlayEnvironment(authContext, overrides.env) : authContext;
	if (overrides.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			provider.id,
			provider.auth.apiKey,
			requestContext,
			{ type: "api_key", key: overrides.apiKey, env: overrides.env },
			signal,
		);
	}

	let stored: Credential | undefined;
	try {
		stored = await credentials.read(provider.id, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${provider.id}`, { cause: error });
	}
	if (stored) {
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(provider.id, provider.auth.apiKey, requestContext, credential, signal);
		}
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveOAuth(provider.id, provider.auth.oauth, credentials, stored, overrides, signal);
		}
		return undefined;
	}

	return provider.auth.apiKey
		? resolveApiKey(provider.id, provider.auth.apiKey, requestContext, undefined, signal)
		: undefined;
}

function overlayEnvironment(base: AuthContext, environment: ProviderEnv): AuthContext {
	return {
		env: async (name) => environment[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

async function resolveApiKey(
	providerId: string,
	auth: NonNullable<ProviderAuth["apiKey"]>,
	context: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await auth.resolve({ ctx: context, credential, signal });
	} catch (error) {
		signal.throwIfAborted();
		throw new ModelsError("auth", `API key resolution failed for provider ${providerId}`, { cause: error });
	}
}

async function resolveOAuth(
	providerId: string,
	oauth: NonNullable<ProviderAuth["oauth"]>,
	credentials: CredentialStore,
	stored: OAuthCredential,
	overrides: AuthResolutionOverrides & { clock: Clock },
	signal: AbortSignal,
): Promise<AuthResult> {
	const now = overrides.clock.now();
	const minimumValidity = overrides.minOAuthValidityMs ?? 5 * 60 * 1_000;
	let credential = stored;
	if (credential.expires - now <= minimumValidity) {
		try {
			const updated = await credentials.modify(
				providerId,
				async (current) => {
					if (current?.type !== "oauth") return undefined;
					if (current.expires - now > minimumValidity) return undefined;
					return oauth.refresh(current, signal);
				},
				{ signal },
			);
			if (updated?.type === "oauth") credential = updated;
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("oauth", `OAuth refresh failed for provider ${providerId}`, { cause: error });
		}
	}
	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth conversion failed for provider ${providerId}`, { cause: error });
	}
}
