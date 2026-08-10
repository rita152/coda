import { describe, expect, it } from "vitest";
import { type McpToolResult, projectMcpToolResult } from "../src/index.ts";

describe("MCP Tool result projection", () => {
	it("rejects unsafe limits and keeps tiny text projections inside their bound", () => {
		expect(() =>
			projectMcpToolResult({ isError: false, content: [] }, { maxTextCharacters: Number.POSITIVE_INFINITY }),
		).toThrow("maxTextCharacters");
		expect(() => projectMcpToolResult({ isError: false, content: [] }, { maxImageBytes: -1 })).toThrow(
			"maxImageBytes",
		);
		const projection = projectMcpToolResult(
			{ isError: false, content: [{ type: "text", text: "long text" }] },
			{ maxTextCharacters: 3 },
		);
		expect(projection.content).toEqual([{ type: "text", text: "\n… " }]);
		expect((projection.content[0] as { readonly text: string }).text).toHaveLength(3);
	});

	it("projects every content kind without silently dropping unsupported model content", () => {
		const result: McpToolResult = {
			isError: false,
			content: [
				{ type: "text", text: "plain text" },
				{
					type: "image",
					data: "aGVsbG8=",
					mimeType: "image/png",
					annotations: { audience: ["assistant"] },
					meta: { retained: true },
				},
				{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "https://example.test/report",
					name: "report",
					mimeType: "text/html",
				},
				{
					type: "resource",
					resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "embedded notes" },
				},
			],
			structuredContent: { z: 2, a: 1 },
		};

		const projection = projectMcpToolResult(result);

		expect(projection.content).toEqual([
			{ type: "text", text: "plain text" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "[MCP audio: audio/wav, 5 bytes; binary payload omitted from model content]" },
			{
				type: "text",
				text: "[MCP resource link: report — https://example.test/report (text/html)]",
			},
			{
				type: "text",
				text: "[MCP embedded resource: file:///notes.txt (text/plain)]\nembedded notes",
			},
			{ type: "text", text: '[MCP structured content]\n{\n  "a": 1,\n  "z": 2\n}' },
		]);
		expect(projection.details).toEqual({
			contentTypes: ["text", "image", "audio", "resource_link", "resource"],
			hasStructuredContent: true,
			truncated: false,
		});
		expect(result.content[2]).toEqual({ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" });
	});

	it("replaces over-limit binary content with an explicit bounded descriptor", () => {
		const projection = projectMcpToolResult(
			{
				isError: false,
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
			{ maxImageBytes: 4 },
		);

		expect(projection.content).toEqual([
			{ type: "text", text: "[MCP image: image/png, 5 bytes; omitted because it exceeds the 4 byte limit]" },
		]);
		expect(projection.details.truncated).toBe(true);
	});

	it("bounds the complete model projection including structured-content notices", () => {
		const projection = projectMcpToolResult(
			{
				isError: false,
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
					{ type: "text", text: "three" },
				],
				structuredContent: { visible: true },
			},
			{ maxContentItems: 2 },
		);

		expect(projection.content).toHaveLength(2);
		expect(projection.content[1]).toEqual({
			type: "text",
			text: "[MCP projection truncated after 2 model-content items]",
		});
		expect(projection.details).toEqual({
			contentTypes: ["text"],
			hasStructuredContent: true,
			truncated: true,
		});
	});
});
