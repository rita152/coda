import type { ToolExecutionContext } from "@coda/agent";
import { Component, createSystemScheduler, stripAnsi, type TerminalInput, Tui, VirtualTerminal } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import type { McpAgentElicitation } from "../../src/mcp/run-capability.ts";
import { InteractiveMcpElicitationHandler, type McpElicitationWaitListener } from "../../src/ui/mcp-elicitation.ts";

class RootComponent extends Component {
	constructor() {
		super({ focusable: true });
	}
	render(): string[] {
		return ["chat"];
	}
}

function key(
	value: Extract<TerminalInput, { type: "key" }>["key"],
	options: { control?: boolean } = {},
): Extract<TerminalInput, { type: "key" }> {
	return {
		type: "key",
		key: value,
		text: value === "space" ? " " : value.length === 1 ? value : undefined,
		shift: false,
		control: options.control ?? false,
		alt: false,
		meta: false,
		action: "press",
	};
}

const execution: ToolExecutionContext = {
	signal: new AbortController().signal,
	runId: "run:1" as never,
	turnId: "turn:1" as never,
	invocationId: "invocation:1" as never,
	resultMessageId: "message:1" as never,
	providerToolCallId: "provider-call",
};

function request(
	value: McpAgentElicitation["request"],
	executionOverride: ToolExecutionContext = execution,
): McpAgentElicitation {
	return {
		server: {
			id: "deploy",
			status: "ready",
			server: { name: "Deployment Service", version: "1.0.0" },
			toolCount: 1,
		},
		tool: {
			id: "mcp:deploy:release",
			serverId: "deploy",
			remoteName: "release",
			name: "mcp__deploy__release",
			description: "Release",
			inputSchema: { type: "object", properties: {} },
		},
		request: value,
		execution: executionOverride,
	};
}

async function setup(onWait?: McpElicitationWaitListener) {
	const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
	const root = new RootComponent();
	const tui = new Tui({
		terminal,
		root,
		clock: { now: () => 1_000 },
		scheduler: createSystemScheduler(),
		keybindings: [],
	});
	const handler = new InteractiveMcpElicitationHandler();
	handler.bind(tui, terminal, onWait);
	await tui.start();
	return { terminal, root, tui, handler };
}

describe("interactive MCP Elicitation", () => {
	it("reports session-scoped actionable waits until the Elicitation resolves", async () => {
		const onWait = vi.fn<McpElicitationWaitListener>();
		const { terminal, tui, handler } = await setup(onWait);
		const elicitation = request({
			mode: "form",
			message: "Choose a target",
			requestedSchema: { type: "object", properties: {} },
		});
		handler.setActiveSession("session-1");
		const pending = handler.forSession("session-1")(elicitation);

		expect(onWait).toHaveBeenLastCalledWith(elicitation, "session-1", true);
		await terminal.emit(key("escape"));
		await expect(pending).resolves.toEqual({ action: "cancel" });
		expect(onWait).toHaveBeenLastCalledWith(elicitation, "session-1", false);
		handler.unbind();
		await tui.stop();
	});

	it("shows the full URL and Server identity without opening it, then accepts explicit completion", async () => {
		const { terminal, tui, handler } = await setup();
		const pending = handler.request(
			request({
				mode: "url",
				message: "Sign in to continue",
				url: "https://accounts.example.test/authorize?request=123",
			}),
		);
		await tui.renderNow();
		const rendered = stripAnsi(terminal.readOutput());
		expect(rendered).toContain("Deployment Service (deploy)");
		expect(rendered).toContain("https://accounts.example.test/authorize?request=123");
		expect(rendered).toContain("will not prefetch or open this URL");

		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({ action: "accept" });
		handler.unbind();
		await tui.stop();
	});

	it("collects a restricted form and preserves accept, decline, and cancel as distinct outcomes", async () => {
		const { terminal, tui, handler } = await setup();
		const pending = handler.request(
			request({
				mode: "form",
				message: "Choose release options",
				requestedSchema: {
					type: "object",
					properties: {
						region: { type: "string", enum: ["eu", "us"] },
						confirm: { type: "boolean" },
					},
					required: ["region", "confirm"],
				},
			}),
		);
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Do not enter passwords, tokens, API keys");

		await terminal.emit(key("right"));
		await terminal.emit(key("down"));
		await terminal.emit(key("space"));
		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({
			action: "accept",
			content: { region: "us", confirm: true },
		});

		const declined = handler.request(
			request({ mode: "form", message: "Optional", requestedSchema: { type: "object", properties: {} } }),
		);
		await terminal.emit(key("d", { control: true }));
		await expect(declined).resolves.toEqual({ action: "decline" });

		const cancelled = handler.request(
			request({ mode: "form", message: "Optional", requestedSchema: { type: "object", properties: {} } }),
		);
		await terminal.emit(key("escape"));
		await expect(cancelled).resolves.toEqual({ action: "cancel" });
		handler.unbind();
		await tui.stop();
	});

	it("declines a form that asks for secrets without displaying an input surface", async () => {
		const { tui, handler } = await setup();
		await expect(
			handler.request(
				request({
					mode: "form",
					message: "Enter credentials",
					requestedSchema: {
						type: "object",
						properties: { apiKey: { type: "string" } },
						required: ["apiKey"],
					},
				}),
			),
		).resolves.toEqual({ action: "decline" });
		const describedSecret = handler.request(
			request({
				mode: "form",
				message: "Additional data",
				requestedSchema: {
					type: "object",
					properties: {
						value: { type: "string", description: "Paste the access token for this account" },
					},
				},
			}),
		);
		handler.unbind();
		await expect(describedSecret).resolves.toEqual({ action: "decline" });
		await tui.stop();
	});

	it("cancels an active overlay when its Tool call aborts", async () => {
		const { terminal, tui, handler } = await setup();
		const controller = new AbortController();
		const pending = handler.request(
			request(
				{
					mode: "url",
					message: "Complete the operation",
					url: "https://accounts.example.test/continue",
				},
				{ ...execution, signal: controller.signal },
			),
		);
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Complete the operation");

		controller.abort();

		await expect(pending).resolves.toEqual({ action: "cancel" });
		terminal.clearOutput();
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).not.toContain("Complete the operation");
		handler.unbind();
		await tui.stop();
	});
});
