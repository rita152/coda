import type { Model } from "@coda/ai";

export interface ModelRuntimeCapabilities {
	readonly toolResultImages: boolean;
}

export interface ModelCapabilityResolver {
	resolve(model: Model): ModelRuntimeCapabilities;
}

const UNSUPPORTED_CAPABILITIES: ModelRuntimeCapabilities = Object.freeze({
	toolResultImages: false,
});

export function resolveModelRuntimeCapabilities(
	model: Model,
	resolver?: ModelCapabilityResolver,
): ModelRuntimeCapabilities {
	return resolver ? Object.freeze({ ...resolver.resolve(model) }) : UNSUPPORTED_CAPABILITIES;
}
