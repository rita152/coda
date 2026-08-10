import type { Api, Model, ModelCost } from "@coda/ai";

export type CatalogValue<T> = T | "unknown";

export interface CatalogModelMetadata {
	readonly contextWindow: CatalogValue<number>;
	readonly maxOutputTokens: CatalogValue<number>;
	readonly reasoning: CatalogValue<boolean>;
	readonly imageInput: CatalogValue<boolean>;
	readonly price: CatalogValue<ModelCost>;
}

/** Conservative local execution constraints, never claimed as Provider metadata. */
export interface CompatibilityModelConstraints {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly reasoning: false;
	readonly imageInput: false;
	readonly price: "unreported";
}

export interface CatalogModel {
	readonly key: string;
	readonly providerId: string;
	readonly id: string;
	readonly name: string;
	readonly runtime: Model<Api>;
	readonly metadata: CatalogModelMetadata;
	readonly compatibility?: CompatibilityModelConstraints;
	readonly stale?: boolean;
}

export function catalogModelFromRuntime(model: Model<Api>): CatalogModel {
	return Object.freeze({
		key: `${model.provider}/${model.id}`,
		providerId: model.provider,
		id: model.id,
		name: model.name,
		runtime: model,
		metadata: Object.freeze({
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxTokens,
			reasoning: model.reasoning,
			imageInput: model.input.includes("image"),
			price: model.cost ?? "unknown",
		}),
	});
}
