export const COMPATIBILITY_CONTEXT_WINDOW = 16_384;
export const COMPATIBILITY_MAX_TOKENS = 4_096;

export type ModelMetadataSource = "provider" | "user" | "compatibility";

/** A capability value together with the authority that supplied it. */
export interface ModelMetadataValue<T, TSource extends ModelMetadataSource = ModelMetadataSource> {
	readonly source: TSource;
	readonly value: T;
}

export type DeclaredModelMetadataValue<T> = ModelMetadataValue<T, Exclude<ModelMetadataSource, "compatibility">>;

export function modelMetadataValue<T, TSource extends ModelMetadataSource>(
	value: T,
	source: TSource,
): ModelMetadataValue<T, TSource> {
	return Object.freeze({ source, value });
}

export function isCompatibilityValue<T>(
	metadata: ModelMetadataValue<T>,
): metadata is ModelMetadataValue<T, "compatibility"> {
	return metadata.source === "compatibility";
}
