import { describe, expect, it } from "vitest";
import { parseCommandQuery, resolveCommandInvocation } from "../src/commands/parser.ts";
import { CommandRegistry } from "../src/commands/registry.ts";

describe("parseCommandQuery", () => {
	it("distinguishes Composer-start commands from inline Extension boundaries", () => {
		expect(parseCommandQuery("/mo", 3)).toEqual({
			location: "composer_start",
			query: "mo",
			range: { start: 0, end: 3 },
		});
		expect(parseCommandQuery("use /sk now", 7)).toEqual({
			location: "token_boundary",
			query: "sk",
			range: { start: 4, end: 7 },
		});
		expect(parseCommandQuery("use/path", 8)).toBeUndefined();
		expect(parseCommandQuery(" /model", 7)).toEqual({
			location: "token_boundary",
			query: "model",
			range: { start: 1, end: 7 },
		});
	});

	it("resolves only Core submissions allowed by the command argument policy", () => {
		const registry = new CommandRegistry();
		registry.register({
			id: "core:model",
			name: "model",
			aliases: ["models"],
			title: "Model",
			source: "core",
			kind: "control",
			triggerScope: "composer_start",
			arguments: { kind: "none" },
		});
		registry.register({
			id: "core:follow-up",
			name: "follow-up",
			title: "Follow-up",
			source: "core",
			kind: "action",
			triggerScope: "composer_start",
			arguments: { kind: "tail", required: true },
		});

		expect(resolveCommandInvocation(registry, "/MODELS")).toMatchObject({
			command: { id: "core:model" },
			argument: undefined,
		});
		expect(resolveCommandInvocation(registry, "/model extra")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/follow-up check the tests")).toMatchObject({
			command: { id: "core:follow-up" },
			argument: "check the tests",
		});
		expect(resolveCommandInvocation(registry, "/follow-up")).toBeUndefined();
		expect(resolveCommandInvocation(registry, " /model")).toBeUndefined();
	});
});
