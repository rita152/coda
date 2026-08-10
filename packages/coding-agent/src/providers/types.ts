export const AUTH_API_PROTOCOLS = ["openai.chatcompletions", "openai.responses", "anthropic.messages"] as const;

export type AuthApiProtocol = (typeof AUTH_API_PROTOCOLS)[number];

export interface CustomProviderInput {
	readonly providerName: string;
	readonly apiProtocol: AuthApiProtocol;
	readonly baseUrl: string;
	readonly apiKey: string;
}

export interface CustomProviderModelConfig {
	readonly id: string;
	readonly name: string;
}

/** Serializable provider configuration. Credentials are deliberately absent. */
export interface CustomProviderConfig {
	readonly id: string;
	readonly name: string;
	readonly apiProtocol: AuthApiProtocol;
	readonly baseUrl: string;
	readonly discovery: "ready" | "needs_attention";
	readonly models: readonly CustomProviderModelConfig[];
}

export interface ProviderAuthenticationEntry {
	readonly id: string;
	readonly name: string;
	readonly configured: boolean;
}
