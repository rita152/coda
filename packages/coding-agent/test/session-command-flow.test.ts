import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionCommandFlow,
	sessionApiProtocolLabel,
	sessionCommandEntryFromSummary,
} from "../src/commands/session-flow.ts";
import type { SessionId } from "../src/session/types.ts";
import { CommandFlowHost } from "../src/ui/command-flow-host.ts";

describe("session command flow", () => {
	it("shows only workspace sessions and switches directly to the selected runtime", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createSessionCommandFlow({
				sessions: [
					{ id: "session-a", label: "Session A", status: "current" },
					{ id: "session-b", label: "Session B", status: "needs attention" },
				],
				onSelect,
			}),
		);

		expect(host.view?.items.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: "session-a", status: "current" },
			{ id: "session-b", status: "needs attention" },
		]);
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(onSelect).toHaveBeenCalledWith("session-b");
		expect(host.view).toBeUndefined();
	});

	it.each([
		["openai-completions", "OpenAI Chat Completions"],
		["openai-responses", "OpenAI Responses"],
		["anthropic-messages", "Anthropic Messages"],
	])("labels the %s protocol", (api, label) => {
		expect(sessionApiProtocolLabel(api)).toBe(label);
	});

	it("turns rich Session metadata into a readable picker entry", () => {
		const entry = sessionCommandEntryFromSummary(
			{
				descriptor: {
					id: "session-12345678" as SessionId,
					workspace: { id: "workspace", path: "/workspace" },
					createdAt: 1_000,
					persistent: true,
				},
				title: "Fix the session picker",
				updatedAt: 30_000,
				promptCount: 2,
				model: { provider: "openai", id: "gpt-5", api: "openai-responses" },
			},
			90_000,
		);

		expect(entry).toEqual({
			id: "session-12345678",
			label: "Fix the session picker",
			description: "1m ago · openai/gpt-5 · OpenAI Responses · 2 prompts",
		});
	});
});

function key(keyName: KeyInput["key"]): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
	};
}
