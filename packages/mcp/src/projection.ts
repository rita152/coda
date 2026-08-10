import type { McpToolContent, McpToolResult } from "./types.ts";

export interface McpProjectionLimits {
	readonly maxContentItems: number;
	readonly maxTextCharacters: number;
	readonly maxImageBytes: number;
	readonly maxEmbeddedTextCharacters: number;
	readonly maxStructuredCharacters: number;
}

export const DEFAULT_MCP_PROJECTION_LIMITS: McpProjectionLimits = Object.freeze({
	maxContentItems: 128,
	maxTextCharacters: 100_000,
	maxImageBytes: 20 * 1024 * 1024,
	maxEmbeddedTextCharacters: 100_000,
	maxStructuredCharacters: 100_000,
});

function validateProjectionLimits(limits: McpProjectionLimits): void {
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`MCP projection limit ${key} must be a non-negative safe integer`);
		}
	}
}

export type McpModelContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface McpToolResultProjection {
	readonly isError: boolean;
	readonly content: readonly McpModelContent[];
	readonly details: {
		readonly contentTypes: readonly McpToolContent["type"][];
		readonly hasStructuredContent: boolean;
		readonly truncated: boolean;
	};
}

function base64ByteLength(value: string): number {
	const compact = value.replace(/\s/gu, "");
	if (compact.length === 0) return 0;
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, canonicalJson(child)]),
	);
}

function boundedText(value: string, limit: number): { readonly text: string; readonly truncated: boolean } {
	if (value.length <= limit) return { text: value, truncated: false };
	const suffix = "\n… [truncated]";
	if (limit <= suffix.length) return { text: suffix.slice(0, limit), truncated: true };
	return { text: `${value.slice(0, limit - suffix.length)}${suffix}`, truncated: true };
}

function resourceLinkText(content: Extract<McpToolContent, { readonly type: "resource_link" }>): string {
	const label = content.name ? `${content.name} — ` : "";
	const metadata = [content.mimeType, content.size !== undefined ? `${content.size} bytes` : undefined].filter(
		Boolean,
	);
	return `[MCP resource link: ${label}${content.uri}${metadata.length > 0 ? ` (${metadata.join(", ")})` : ""}]`;
}

export function projectMcpToolResult(
	result: McpToolResult,
	overrides: Partial<McpProjectionLimits> = {},
): McpToolResultProjection {
	const limits: McpProjectionLimits = { ...DEFAULT_MCP_PROJECTION_LIMITS, ...overrides };
	validateProjectionLimits(limits);
	const content: McpModelContent[] = [];
	const contentTypes: McpToolContent["type"][] = [...new Set(result.content.map((item) => item.type))];
	let truncated = false;
	let capacityTruncated = false;
	const append = (item: McpModelContent): boolean => {
		if (content.length >= limits.maxContentItems) {
			truncated = true;
			capacityTruncated = true;
			return false;
		}
		content.push(item);
		return true;
	};
	const appendText = (value: string, limit = limits.maxTextCharacters): void => {
		const bounded = boundedText(value, limit);
		append({ type: "text", text: bounded.text });
		truncated ||= bounded.truncated;
	};

	for (const item of result.content) {
		if (content.length >= limits.maxContentItems) {
			truncated = true;
			capacityTruncated = true;
			break;
		}
		switch (item.type) {
			case "text":
				appendText(item.text);
				break;
			case "image": {
				const bytes = base64ByteLength(item.data);
				if (bytes <= limits.maxImageBytes) {
					append({ type: "image", data: item.data, mimeType: item.mimeType });
				} else {
					appendText(
						`[MCP image: ${item.mimeType}, ${bytes} bytes; omitted because it exceeds the ${limits.maxImageBytes} byte limit]`,
					);
					truncated = true;
				}
				break;
			}
			case "audio":
				appendText(
					`[MCP audio: ${item.mimeType}, ${base64ByteLength(item.data)} bytes; binary payload omitted from model content]`,
				);
				break;
			case "resource_link":
				appendText(resourceLinkText(item));
				break;
			case "resource": {
				const resource = item.resource;
				const heading = `[MCP embedded resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`;
				if ("text" in resource) appendText(`${heading}\n${resource.text}`, limits.maxEmbeddedTextCharacters);
				else {
					appendText(
						`${heading}\n[binary blob: ${base64ByteLength(resource.blob)} bytes; payload omitted from model content]`,
						limits.maxEmbeddedTextCharacters,
					);
				}
				break;
			}
		}
	}

	if (result.structuredContent !== undefined) {
		let serialized: string;
		try {
			serialized = JSON.stringify(canonicalJson(result.structuredContent), null, 2);
		} catch {
			serialized = "[unserializable structured content omitted from model content]";
			truncated = true;
		}
		appendText(`[MCP structured content]\n${serialized}`, limits.maxStructuredCharacters);
	}
	if (capacityTruncated && limits.maxContentItems > 0) {
		const notice: McpModelContent = {
			type: "text",
			text: `[MCP projection truncated after ${limits.maxContentItems} model-content items]`,
		};
		if (content.length >= limits.maxContentItems) content[content.length - 1] = notice;
		else content.push(notice);
	}

	return Object.freeze({
		isError: result.isError,
		content: Object.freeze(content.map((item) => Object.freeze(item))),
		details: Object.freeze({
			contentTypes: Object.freeze(contentTypes),
			hasStructuredContent: result.structuredContent !== undefined,
			truncated,
		}),
	});
}
