import { randomUUID } from "node:crypto";
import type { Editor, EditorMarker } from "@coda/tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { ComposerExtensionReference } from "./input-types.ts";

const EXTENSION_MARKER_KIND = "slash-command-extension";

interface ExtensionMarkerValue {
	readonly kind: typeof EXTENSION_MARKER_KIND;
	readonly commandId: string;
	readonly source: "skill" | "mcp";
	readonly name: string;
}

export function addExtensionReference(
	editor: Editor,
	command: CommandDefinition,
	start: number,
	end: number,
): ComposerExtensionReference {
	if (command.source !== "skill" && command.source !== "mcp") {
		throw new Error(`Core command cannot become an extension reference: ${command.id}`);
	}
	const id = `extension-reference:${randomUUID()}`;
	editor.addMarker({
		id,
		start,
		end,
		value: Object.freeze({
			kind: EXTENSION_MARKER_KIND,
			commandId: command.id,
			source: command.source,
			name: command.name,
		} satisfies ExtensionMarkerValue),
	});
	return Object.freeze({ id, commandId: command.id, source: command.source, name: command.name, start, end });
}

export function extensionReferencesFromMarkers(
	markers: readonly EditorMarker[],
): readonly ComposerExtensionReference[] {
	return Object.freeze(
		markers
			.flatMap((marker) => {
				if (!isExtensionMarkerValue(marker.value)) return [];
				return [
					Object.freeze({
						id: marker.id,
						commandId: marker.value.commandId,
						source: marker.value.source,
						name: marker.value.name,
						start: marker.start,
						end: marker.end,
					}),
				];
			})
			.sort(compareReferences),
	);
}

export function restoreExtensionReferences(
	editor: Editor,
	references: readonly ComposerExtensionReference[] | undefined,
): void {
	for (const reference of references ?? []) {
		editor.addMarker({
			id: reference.id,
			start: reference.start,
			end: reference.end,
			value: Object.freeze({
				kind: EXTENSION_MARKER_KIND,
				commandId: reference.commandId,
				source: reference.source,
				name: reference.name,
			} satisfies ExtensionMarkerValue),
		});
	}
}

function isExtensionMarkerValue(value: unknown): value is ExtensionMarkerValue {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ExtensionMarkerValue>;
	return (
		candidate.kind === EXTENSION_MARKER_KIND &&
		typeof candidate.commandId === "string" &&
		(candidate.source === "skill" || candidate.source === "mcp") &&
		typeof candidate.name === "string"
	);
}

function compareReferences(left: ComposerExtensionReference, right: ComposerExtensionReference): number {
	return left.start - right.start || left.end - right.end || left.id.localeCompare(right.id);
}
