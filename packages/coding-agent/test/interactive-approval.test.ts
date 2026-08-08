import type { RunId, ToolInvocationId } from "@coda/agent";
import { Component, createSystemScheduler, Tui, VirtualTerminal } from "@coda/tui";
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
			runId: "run-1" as RunId,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "bash",
			operation: "bash",
			reason: "shell",
			command: "npm test",
			cwd: "/workspace",
			grantScope: "run",
			hostAuthority: true,
		});
		await tui.renderNow();
		expect(terminal.readOutput()).toContain("npm test");
		expect(terminal.readOutput()).toContain("host-user authority");
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
		await expect(pending).resolves.toBe("allow_run");
		expect(tui.focused).toBe(root);

		approval.unbind();
		await tui.stop();
	});

	it("never widens an outside-Workspace grant to a Run", async () => {
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
			runId: "run-1" as RunId,
			invocationId: "invocation-1" as ToolInvocationId,
			toolName: "read",
			operation: "read",
			reason: "outside_workspace",
			requestedPath: "../outside.txt",
			canonicalPath: "/outside.txt",
			cwd: "/workspace",
			grantScope: "operation",
			hostAuthority: true,
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
		await expect(pending).resolves.toBe("allow_once");
		approval.unbind();
		await tui.stop();
	});
});
