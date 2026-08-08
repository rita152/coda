// Portions derived from Pi:
// /packages/ai/test/validation.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";
import type { Tool, ToolCall } from "../src/index.ts";
import { Type, validateToolArguments, validateToolCall } from "../src/index.ts";

describe("tool argument validation (upstream: /packages/ai/test/validation.test.ts)", () => {
	test("clones and converts TypeBox arguments without mutating the model ToolCall", () => {
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ line: Type.Number() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { line: "42" },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ line: 42 });
		expect(toolCall.arguments).toEqual({ line: "42" });
	});

	test("coerces nested primitives in a serialized plain JSON Schema", () => {
		const tool: Tool = {
			name: "search",
			description: "Search text",
			parameters: {
				type: "object",
				properties: {
					options: {
						type: "object",
						properties: { limit: { type: "integer" }, hidden: { type: "boolean" } },
						required: ["limit", "hidden"],
					},
				},
				required: ["options"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "search",
			arguments: { options: { limit: "3", hidden: "false" } },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ options: { limit: 3, hidden: false } });
	});

	test("looks up Tool names exactly", () => {
		const tool: Tool = {
			name: "Read",
			description: "Read a file",
			parameters: Type.Object({}),
		};
		const toolCall: ToolCall = { type: "toolCall", id: "call-3", name: "read", arguments: {} };

		expect(() => validateToolCall([tool], toolCall)).toThrowError('Tool "read" not found');
	});

	test("reports the failing path and original arguments", () => {
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		};
		const toolCall: ToolCall = { type: "toolCall", id: "call-4", name: "read", arguments: {} };

		expect(() => validateToolArguments(tool, toolCall)).toThrowError(/path:.*Received arguments:\n\{\}/s);
	});
});
