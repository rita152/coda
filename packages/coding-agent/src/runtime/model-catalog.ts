import type { Api, Model, ModelCost } from "@coda/ai";
import { type ModelMetadataValue, modelMetadataValue } from "./model-metadata.ts";

export type CatalogValue<T> = ModelMetadataValue<T>;

export interface CatalogModelMetadata {
	readonly contextWindow: CatalogValue<number>;
	readonly maxOutputTokens: CatalogValue<number>;
	readonly reasoning: CatalogValue<boolean>;
	readonly input: CatalogValue<readonly ("text" | "image")[]>;
	readonly price: CatalogValue<ModelCost | "unreported">;
}

export interface CatalogModel {
	readonly key: string;
	readonly providerId: string;
	readonly id: string;
	readonly name: string;
	readonly runtime: Model<Api>;
	readonly metadata: CatalogModelMetadata;
	readonly stale?: boolean;
}

export function catalogModelFromRuntime(model: Model<Api>): CatalogModel {
	const price: ModelCost | "unreported" = model.cost ?? "unreported";
	return Object.freeze({
		key: `${model.provider}/${model.id}`,
		providerId: model.provider,
		id: model.id,
		name: model.name,
		runtime: model,
		metadata: Object.freeze({
			contextWindow: modelMetadataValue(model.contextWindow, "provider"),
			maxOutputTokens: modelMetadataValue(model.maxTokens, "provider"),
			reasoning: modelMetadataValue(model.reasoning, "provider"),
			input: modelMetadataValue(Object.freeze([...model.input]), "provider"),
			price: modelMetadataValue(price, "provider"),
		}),
	});
}
