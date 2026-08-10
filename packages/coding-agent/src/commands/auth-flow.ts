import type {
	CommandFlowMenu,
	CommandFlowNavigation,
	CommandFlowPrompt,
	CommandFlowScreen,
} from "../interactive/command-flow-host.ts";
import { AUTH_API_PROTOCOLS, type AuthApiProtocol, type CustomProviderInput } from "../providers/types.ts";

export type { AuthApiProtocol, CustomProviderInput } from "../providers/types.ts";
export { AUTH_API_PROTOCOLS } from "../providers/types.ts";

export interface AuthProviderEntry {
	readonly id: string;
	readonly name: string;
	readonly configured: boolean;
}

export interface AuthCommandFlowOptions {
	readonly providers: readonly AuthProviderEntry[];
	readonly onUpdateApiKey: (providerId: string, apiKey: string) => Promise<void> | void;
	readonly onLogout: (providerId: string) => Promise<void> | void;
	readonly onAddCustomProvider: (input: CustomProviderInput) => Promise<void> | void;
}

export function createAuthCommandFlow(options: AuthCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "auth",
		title: "Authentication",
		items: Object.freeze([
			Object.freeze({
				id: "oauth",
				label: "Log in with OAuth",
				disabledReason: "Coming soon",
			}),
			Object.freeze({
				id: "api-key",
				label: "Log in with API key",
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(createApiKeyMenu(options)),
			}),
		]),
	});
}

export function createProviderAuthFlow(
	provider: AuthProviderEntry,
	options: AuthCommandFlowOptions,
): CommandFlowScreen {
	return provider.configured ? createConfiguredProviderMenu(provider, options) : createApiKeyPrompt(provider, options);
}

function createApiKeyMenu(options: AuthCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "auth:api-key",
		title: "API key",
		items: Object.freeze([
			...options.providers.map((provider) =>
				Object.freeze({
					id: `provider:${provider.id}`,
					label: provider.name,
					status: provider.configured ? "configured" : "not configured",
					onSelect: (navigation: CommandFlowNavigation) =>
						navigation.push(createProviderAuthFlow(provider, options)),
				}),
			),
			Object.freeze({
				id: "custom-provider",
				label: "Custom provider",
				description: "Configure a protocol-compatible endpoint",
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(createProviderNamePrompt(options)),
			}),
		]),
	});
}

function createProviderNamePrompt(options: AuthCommandFlowOptions): CommandFlowPrompt {
	return Object.freeze({
		id: "auth:custom:name",
		title: "Custom provider",
		label: "Provider name",
		onSubmit: (providerName: string, navigation: CommandFlowNavigation) =>
			navigation.push(createProtocolMenu(providerName.trim(), options)),
	});
}

function createProtocolMenu(providerName: string, options: AuthCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "auth:custom:protocol",
		title: "API protocol",
		items: Object.freeze(
			AUTH_API_PROTOCOLS.map((apiProtocol) =>
				Object.freeze({
					id: apiProtocol,
					label: apiProtocol,
					onSelect: (navigation: CommandFlowNavigation) =>
						navigation.push(createBaseUrlPrompt(providerName, apiProtocol, options)),
				}),
			),
		),
	});
}

function createBaseUrlPrompt(
	providerName: string,
	apiProtocol: AuthApiProtocol,
	options: AuthCommandFlowOptions,
): CommandFlowPrompt {
	return Object.freeze({
		id: "auth:custom:base-url",
		title: "Base URL",
		label: "Base URL",
		placeholder: "https://api.example.com/v1",
		onSubmit: (baseUrl: string, navigation: CommandFlowNavigation) =>
			navigation.push(createCustomApiKeyPrompt(providerName, apiProtocol, baseUrl.trim(), options)),
	});
}

function createCustomApiKeyPrompt(
	providerName: string,
	apiProtocol: AuthApiProtocol,
	baseUrl: string,
	options: AuthCommandFlowOptions,
): CommandFlowPrompt {
	return Object.freeze({
		id: "auth:custom:api-key",
		title: "API key",
		label: "API key",
		secret: true,
		onSubmit: (apiKey: string, navigation: CommandFlowNavigation) =>
			finish(options.onAddCustomProvider({ providerName, apiProtocol, baseUrl, apiKey }), navigation),
	});
}

function createConfiguredProviderMenu(provider: AuthProviderEntry, options: AuthCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: `auth:provider:${provider.id}`,
		title: provider.name,
		items: Object.freeze([
			Object.freeze({
				id: "update-api-key",
				label: "Update API key",
				onSelect: (navigation: CommandFlowNavigation) => navigation.push(createApiKeyPrompt(provider, options)),
			}),
			Object.freeze({
				id: "logout",
				label: "Cancel provider login",
				onSelect: (navigation: CommandFlowNavigation) => finish(options.onLogout(provider.id), navigation),
			}),
		]),
	});
}

function createApiKeyPrompt(provider: AuthProviderEntry, options: AuthCommandFlowOptions): CommandFlowPrompt {
	return Object.freeze({
		id: `auth:provider:${provider.id}:api-key`,
		title: `${provider.name} › API key`,
		label: "API key",
		secret: true,
		onSubmit: (apiKey: string, navigation: CommandFlowNavigation) =>
			finish(options.onUpdateApiKey(provider.id, apiKey), navigation),
	});
}

function finish(result: Promise<void> | void, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
