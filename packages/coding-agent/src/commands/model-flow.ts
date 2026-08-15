import type { CatalogModel, CatalogModelMetadata, CatalogValue } from "../models/model-catalog.ts";
import { isCompatibilityValue } from "../models/model-metadata.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export interface ModelCommandEntry {
	readonly catalog: CatalogModel;
	readonly auth: "configured" | "authentication_required";
}

export interface ModelCommandFlowOptions {
	readonly currentKey: string;
	readonly models: readonly ModelCommandEntry[];
	readonly onSelect: (model: CatalogModel) => Promise<unknown> | unknown;
	readonly onAuthenticate: (providerId: string, navigation: CommandFlowNavigation) => Promise<void> | void;
}

export function createModelCommandFlow(options: ModelCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "model",
		title: "Model",
		filterable: true,
		items: Object.freeze(
			options.models.map(({ catalog, auth }) =>
				Object.freeze({
					id: catalog.key,
					label: catalog.key,
					description: describeMetadata(catalog.metadata),
					status:
						catalog.key === options.currentKey
							? "current"
							: auth === "authentication_required"
								? "authentication required"
								: catalog.stale
									? "stale"
									: undefined,
					onSelect: (navigation: CommandFlowNavigation) => {
						if (auth === "authentication_required") {
							return options.onAuthenticate(catalog.providerId, navigation);
						}
						if (requiresCompatibilityMode(catalog.metadata)) {
							navigation.push(createCompatibilityModeMenu(catalog, options.onSelect));
							return;
						}
						return finishSelection(options.onSelect(catalog), navigation);
					},
				}),
			),
		),
	});
}

function createCompatibilityModeMenu(
	catalog: CatalogModel,
	onSelect: ModelCommandFlowOptions["onSelect"],
): CommandFlowMenu {
	return Object.freeze({
		id: `model:compatibility:${catalog.key}`,
		title: "Compatibility Mode",
		items: Object.freeze([
			Object.freeze({
				id: "use",
				label: `Use ${catalog.key}`,
				description: describeCompatibilityMode(catalog),
				onSelect: (navigation: CommandFlowNavigation) => finishSelection(onSelect(catalog), navigation),
			}),
		]),
	});
}

function describeCompatibilityMode(catalog: CatalogModel): string {
	const constraints: string[] = [];
	if (isCompatibilityValue(catalog.metadata.contextWindow)) {
		constraints.push(`context cap ${catalog.metadata.contextWindow.value.toLocaleString("en-US")}`);
	}
	if (isCompatibilityValue(catalog.metadata.maxOutputTokens)) {
		constraints.push(`output cap ${catalog.metadata.maxOutputTokens.value.toLocaleString("en-US")}`);
	}
	if (isCompatibilityValue(catalog.metadata.input)) constraints.push("text only");
	if (isCompatibilityValue(catalog.metadata.reasoning)) constraints.push("reasoning off");
	if (isCompatibilityValue(catalog.metadata.price)) constraints.push("price unreported");
	return constraints.join(" • ") || "Provider and configured metadata are complete";
}

function requiresCompatibilityMode(metadata: CatalogModelMetadata): boolean {
	return Object.values(metadata).some(isCompatibilityValue);
}

function finishSelection(result: Promise<unknown> | unknown, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function describeMetadata(metadata: CatalogModelMetadata): string {
	return [
		`context ${formatCount(metadata.contextWindow)}`,
		`output ${formatCount(metadata.maxOutputTokens)}`,
		`reasoning ${formatCapability(metadata.reasoning)}`,
		`input ${formatInput(metadata.input)}`,
		`price ${formatPrice(metadata.price)}`,
	].join(" • ");
}

function formatCount(value: CatalogValue<number>): string {
	return isCompatibilityValue(value) ? "unknown" : `${value.value.toLocaleString("en-US")} (${sourceLabel(value)})`;
}

function formatCapability(value: CatalogValue<boolean>): string {
	return isCompatibilityValue(value) ? "unknown" : `${value.value ? "yes" : "no"} (${sourceLabel(value)})`;
}

function formatInput(value: CatalogModelMetadata["input"]): string {
	return isCompatibilityValue(value) ? "unknown" : `${value.value.join("+")} (${sourceLabel(value)})`;
}

function formatPrice(value: CatalogModelMetadata["price"]): string {
	if (isCompatibilityValue(value)) return "unknown";
	return `${value.value === "unreported" ? "unreported" : "known"} (${sourceLabel(value)})`;
}

function sourceLabel(value: CatalogValue<unknown>): string {
	return value.source === "provider" ? "Provider" : "configured";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
