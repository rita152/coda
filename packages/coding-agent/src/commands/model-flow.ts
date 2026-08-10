import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";
import type { CatalogModel, CatalogModelMetadata, CatalogValue } from "../runtime/model-catalog.ts";

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
	const compatibility = catalog.compatibility;
	if (!compatibility) return "Some limits, capabilities, or price metadata are unknown";
	return [
		`context cap ${compatibility.contextWindow.toLocaleString("en-US")}`,
		`output cap ${compatibility.maxOutputTokens.toLocaleString("en-US")}`,
		"text only",
		"reasoning off",
		"price unreported",
	].join(" • ");
}

function requiresCompatibilityMode(metadata: CatalogModelMetadata): boolean {
	return Object.values(metadata).some((value) => value === "unknown");
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
		`image ${formatCapability(metadata.imageInput)}`,
		`price ${metadata.price === "unknown" ? "unknown" : "known"}`,
	].join(" • ");
}

function formatCount(value: CatalogValue<number>): string {
	return value === "unknown" ? value : value.toLocaleString("en-US");
}

function formatCapability(value: CatalogValue<boolean>): string {
	return value === "unknown" ? value : value ? "yes" : "no";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
