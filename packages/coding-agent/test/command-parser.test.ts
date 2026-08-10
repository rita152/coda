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
		expect(parseCommandQuery(" /permission", 12)).toEqual({
			location: "token_boundary",
			query: "permission",
			range: { start: 1, end: 12 },
		});
	});

	it("resolves only Core submissions allowed by the command argument policy", () => {
		const registry = new CommandRegistry();
		registry.register({
			id: "core:permission",
			name: "permission",
			aliases: ["permissions"],
			title: "Permission",
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

		expect(resolveCommandInvocation(registry, "/PERMISSIONS")).toMatchObject({
			command: { id: "core:permission" },
			argument: undefined,
		});
		expect(resolveCommandInvocation(registry, "/permission workspace")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/follow-up check the tests")).toMatchObject({
			command: { id: "core:follow-up" },
			argument: "check the tests",
		});
		expect(resolveCommandInvocation(registry, "/follow-up")).toBeUndefined();
		expect(resolveCommandInvocation(registry, " /permission")).toBeUndefined();
	});
});
