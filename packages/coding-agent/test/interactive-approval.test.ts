import type { RunId, ToolInvocationId } from "@coda/agent";
import { Component, createSystemScheduler, stripAnsi, Tui, VirtualTerminal } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { InteractiveApprovalHandler } from "../src/interactive/approval.ts";

class RootComponent extends Component {
	constructor() {
		super({ focusable: true });
	}

	render(): string[] {
		return ["chat"];
	}
}

describe("interactive approval overlay", () => {
	it("queues concurrent approval requests instead of rejecting a later Tool", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const approval = new InteractiveApprovalHandler();
		approval.bind(tui, terminal);
		await tui.start();
		const request = {
			kind: "command" as const,
			runId: "run-1" as RunId,
			turnId: "turn-1" as never,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "bash",
			reason: "command requires approval",
			command: "first command",
			cwd: "/workspace",
		};
		const first = approval.decide(request);
		const second = approval.decide({
			...request,
			invocationId: "invocation-2" as ToolInvocationId,
			command: "second command",
		});
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("first command");

		terminal.clearOutput();
		await terminal.emit({
			type: "key",
			key: "1",
			text: "1",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(first).resolves.toEqual({ type: "approved" });
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("second command");

		await terminal.emit({
			type: "key",
			key: "a",
			text: "a",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(second).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});

	it("shows authority and scope, returns the selected decision, and restores focus", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const root = new RootComponent();
		const tui = new Tui({
			terminal,
			root,
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const approval = new InteractiveApprovalHandler();
		approval.bind(tui, terminal);
		await tui.start();

		const pending = approval.decide({
			kind: "command",
			runId: "run-1" as RunId,
			turnId: "turn-1" as never,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "bash",
			reason: "command requested additional Sandbox permissions",
			command: "npm test",
			cwd: "/workspace",
			sandboxPermissions: "use_default",
			proposedCommandRule: ["npm", "test"],
		});
		await tui.renderNow();
		expect(terminal.readOutput()).toContain("npm test");
		expect(terminal.readOutput()).toContain("active OS Sandbox");
		expect(terminal.readOutput()).toContain("save Command Rule");
		expect(terminal.readOutput()).not.toContain("approve for session");
		expect(tui.focused).not.toBe(root);

		await terminal.emit({
			type: "key",
			key: "2",
			text: "2",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(pending).resolves.toEqual({
			type: "approved-execpolicy-amendment",
			command: ["npm", "test"],
		});
		expect(tui.focused).toBe(root);

		approval.unbind();
		await tui.stop();
	});

	it("can cache an exact filesystem approval for the process session", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const approval = new InteractiveApprovalHandler();
		approval.bind(tui, terminal);
		await tui.start();
		const pending = approval.decide({
			kind: "filesystem",
			runId: "run-1" as RunId,
			turnId: "turn-1" as never,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "read",
			operation: "read",
			reason: "path is outside the configured writable roots",
			requestedPath: "../outside.txt",
			canonicalPath: "/outside.txt",
			cwd: "/workspace",
		});
		await terminal.emit({
			type: "key",
			key: "2",
			text: "2",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(pending).resolves.toEqual({ type: "approved-for-session" });
		approval.unbind();
		await tui.stop();
	});

	it("reflows on resize without hiding authority or grant scope", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const approval = new InteractiveApprovalHandler();
		approval.bind(tui, terminal);
		await tui.start();
		const pending = approval.decide({
			kind: "command",
			runId: "run-1" as RunId,
			turnId: "turn-1" as never,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "bash",
			reason: "command requested additional Sandbox permissions",
			command: "npm run test --workspace=@coda/coding-agent",
			cwd: "/workspace",
			sandboxPermissions: "require_escalated",
		});

		terminal.clearOutput();
		await expect(terminal.emit({ type: "resize", columns: 40, rows: 12 })).resolves.toBeUndefined();
		const resized = stripAnsi(terminal.readOutput());
		expect(resized).toContain("Authority:");
		expect(resized).toContain("Grant:");
		expect(resized).toContain("approve once");

		await terminal.emit({
			type: "key",
			key: "escape",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(pending).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});

	it("offers only one-shot approval and abort for exact additional permissions", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		const approval = new InteractiveApprovalHandler();
		approval.bind(tui, terminal);
		await tui.start();
		const pending = approval.decide({
			kind: "command",
			runId: "run-1" as RunId,
			turnId: "turn-1" as never,
			invocationId: "invocation-1" as ToolInvocationId,
			reason: "command requested additional Sandbox permissions",
			command: "npm install",
			cwd: "/workspace",
			sandboxPermissions: "with_additional_permissions",
			additionalPermissions: { file_system: { write: ["/cache/npm"] } },
			proposedCommandRule: ["npm", "install"],
		});
		await tui.renderNow();
		const output = stripAnsi(terminal.readOutput());
		expect(output).toContain("approve once");
		expect(output).toContain("abort");
		expect(output).toContain("only the displayed additional perm");
		expect(output).not.toContain("approve for session");
		expect(output).not.toContain("save Command Rule");

		await terminal.emit({
			type: "key",
			key: "a",
			text: "a",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(pending).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});
});
