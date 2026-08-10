import type { RunId, ToolInvocationId } from "@coda/agent";
import { Component, createSystemScheduler, stripAnsi, type TerminalInput, Tui, VirtualTerminal } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { StrictScreen } from "../../tui/test/support/strict-screen.ts";
import { InteractiveApprovalHandler } from "../src/interactive/approval.ts";
import type { PermissionApprovalRequest } from "../src/permissions/permission-engine.ts";

class RootComponent extends Component {
	constructor() {
		super({ focusable: true });
	}

	render(): string[] {
		return ["chat"];
	}
}

function commandRequest(command = "npm test"): PermissionApprovalRequest {
	return {
		kind: "command",
		runId: "run-1" as RunId,
		turnId: "turn-1" as never,
		invocationId: `invocation:${command}` as ToolInvocationId,
		toolName: "bash",
		reason: "run the repository test suite",
		command,
		cwd: "/workspace/coda",
		environmentId: "local",
		sandboxPermissions: "use_default",
	};
}

function key(
	value: Extract<TerminalInput, { type: "key" }>["key"],
	modifiers: Partial<Pick<Extract<TerminalInput, { type: "key" }>, "shift" | "control" | "alt" | "meta">> = {},
): Extract<TerminalInput, { type: "key" }> {
	return {
		type: "key",
		key: value,
		text: value.length === 1 ? value : undefined,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...modifiers,
	};
}

async function setup(columns = 80, rows = 24, appearance: "light" | "dark" | "unknown" = "dark") {
	const terminal = new VirtualTerminal({ columns, rows, capabilities: { appearance } });
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
	return { terminal, root, tui, approval };
}

describe("interactive Approval Bar", () => {
	it("defers a background Session approval until that Session receives focus", async () => {
		const { terminal, root, tui, approval } = await setup();
		const observed: Array<{ readonly command?: string; readonly sessionId?: string }> = [];
		approval.bind(tui, terminal, (request, sessionId) => observed.push({ command: request.command, sessionId }));
		approval.setActiveSession("session-a");

		const pending = approval.forSession("session-b").decide(commandRequest("background command"));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).not.toContain("background command");
		expect(tui.focused).toBe(root);
		expect(approval.pendingSessionIds).toEqual(["session-b"]);
		expect(observed).toEqual([{ command: "background command", sessionId: "session-b" }]);

		terminal.clearOutput();
		approval.setActiveSession("session-b");
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("background command");
		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({ type: "approved" });

		approval.unbind();
		await tui.stop();
	});

	it("is a full-width bottom overlay and reviews concurrent requests in FIFO order", async () => {
		const { terminal, tui, approval } = await setup();
		const first = approval.decide(commandRequest("first command"));
		const second = approval.decide({
			...commandRequest("second command"),
			invocationId: "invocation:second" as ToolInvocationId,
		});
		await tui.renderNow();
		const firstFrame = stripAnsi(terminal.readOutput());
		expect(firstFrame).toContain("Would you like to run the following command?");
		expect(firstFrame).toContain("first command");
		expect(firstFrame).not.toContain("requests queued");
		expect(firstFrame).not.toContain("Approval required");

		terminal.clearOutput();
		await terminal.emit(key("1"));
		await expect(first).resolves.toEqual({ type: "approved" });
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("second command");

		await terminal.emit(key("c", { control: true }));
		await expect(second).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});

	it("matches the Codex interaction by selecting the first decision and confirming it with Enter", async () => {
		const { terminal, root, tui, approval } = await setup();
		const pending = approval.decide(commandRequest());
		await tui.renderNow();
		const rendered = terminal.readOutput();
		const initial = stripAnsi(rendered);
		expect(initial).toContain("› 1. Yes, proceed (y)");
		expect(initial).toContain("2. No, and tell Coda what to do differently (esc)");
		expect(initial).toContain("Press enter to confirm or esc to cancel");
		expect(initial).not.toContain("Approval required");
		expect(initial).not.toContain("Workspace:");
		expect(terminal.readOutput()).not.toContain("48;2;43;82;76");
		expect(tui.focused).not.toBe(root);
		const screen = new StrictScreen(80, 24);
		screen.write(rendered);
		expect(screen.viewport().slice(-13)).toEqual([
			"",
			"  Would you like to run the following command?",
			"",
			"  Environment: local",
			"",
			"  Reason: run the repository test suite",
			"",
			"  $ npm test",
			"",
			"› 1. Yes, proceed (y)",
			"  2. No, and tell Coda what to do differently (esc)",
			"",
			"  Press enter to confirm or esc to cancel",
		]);

		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({ type: "approved" });
		expect(tui.focused).toBe(root);

		approval.unbind();
		await tui.stop();
	});

	it("uses the Codex information hierarchy and renders an eligible command prefix in option 2", async () => {
		const { terminal, tui, approval } = await setup(100, 28, "light");
		const pending = approval.decide({
			...commandRequest("npm test -- --runInBand"),
			sandboxPermissions: "require_escalated",
			proposedSessionCommandRule: ["npm", "test"],
			executableIdentity: {
				path: "/usr/local/bin/npm",
				device: "1",
				inode: "42",
				size: 512,
				modifiedAt: 1_000,
			},
		});
		await tui.renderNow();
		const output = stripAnsi(terminal.readOutput());
		expect(output).toContain("Environment: local");
		expect(output).toContain("Reason: run the repository test suite");
		expect(output).toContain("commands that start with `npm test` (p)");
		expect(output).not.toContain("Workspace:");
		expect(output).not.toContain("Authority:");
		expect(output).not.toContain("Executable:");
		expect(output).not.toContain("save Command Rule");

		await terminal.emit(key("p"));
		await expect(pending).resolves.toEqual({
			type: "approved-command-prefix-for-session",
			command: ["npm", "test"],
		});
		approval.unbind();
		await tui.stop();
	});

	it("renders Additional Permissions and multiline commands in the Codex header shape", async () => {
		const { terminal, tui, approval } = await setup(90, 30);
		const pending = approval.decide({
			...commandRequest("python - <<'PY'\nprint('hello')\nPY"),
			sandboxPermissions: "with_additional_permissions",
			additionalPermissions: {
				network: { enabled: true },
				file_system: { read: ["/tmp/readme.txt"], write: ["/tmp/out.txt"] },
			},
		});
		await tui.renderNow();
		const rendered = terminal.readOutput();
		const output = stripAnsi(rendered);
		expect(output).toContain("Permission rule: network; read `/tmp/readme.txt`; write `/tmp/out.txt`");
		const screen = new StrictScreen(90, 30);
		screen.write(rendered);
		const viewport = screen.viewport();
		expect(viewport).toContain("  $ python - <<'PY'");
		expect(viewport).toContain("  print('hello')");
		expect(viewport).toContain("  PY");
		expect(viewport).toContain("  2. No, and tell Coda what to do differently (esc)");

		await terminal.emit(key("escape"));
		await pending;
		approval.unbind();
		await tui.stop();
	});

	it("reviews an immutable snapshot and renders terminal and bidi controls visibly", async () => {
		const { terminal, tui, approval } = await setup(100, 28);
		const prefix = ["npm", "test"];
		const executableIdentity = {
			path: "/usr/local/bin/npm",
			device: "1",
			inode: "42",
			size: 512,
			modifiedAt: 1_000,
		};
		const request = {
			...commandRequest("printf\t\u001b[31m\u202Ehidden\u200F"),
			proposedSessionCommandRule: prefix,
			executableIdentity,
		};
		const pending = approval.decide(request);
		request.command = "mutated after review began";
		prefix[0] = "attacker";
		executableIdentity.path = "/tmp/npm";

		await tui.renderNow();
		const output = stripAnsi(terminal.readOutput());
		expect(output).toContain("[U+001B]");
		expect(output).toContain("[U+0009]");
		expect(output).toContain("[U+202E]");
		expect(output).toContain("[U+200F]");
		expect(output).toContain("commands that start with `npm test` (p)");
		expect(output).not.toContain("mutated after review began");
		expect(output).not.toContain("/tmp/npm");

		await terminal.emit(key("escape"));
		await pending;
		approval.unbind();
		await tui.stop();
	});

	it("never grants from pasted input and disables approval while the terminal is unsafe to review", async () => {
		const { terminal, tui, approval } = await setup(36, 9);
		let settled = false;
		const pending = approval.decide(commandRequest()).then((decision) => {
			settled = true;
			return decision;
		});
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Approval pending — resize terminal");
		terminal.clearOutput();
		await terminal.emit(key("page-down"));
		await terminal.emit(key("page-down"));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("$ npm test");

		await terminal.emit({ type: "paste", text: "1\ny\n" });
		await terminal.emit(key("1"));
		expect(settled).toBe(false);

		await terminal.emit({ type: "resize", columns: 80, rows: 24 });
		await terminal.emit({ type: "paste", text: "1" });
		expect(settled).toBe(false);
		await terminal.emit(key("y"));
		await expect(pending).resolves.toEqual({ type: "approved" });
		approval.unbind();
		await tui.stop();
	});

	it("keeps the Codex choices and footer reachable in a narrow terminal", async () => {
		const { terminal, tui, approval } = await setup(40, 12);
		const pending = approval.decide(commandRequest("npm test -- --runInBand"));
		await tui.renderNow();
		const initial = stripAnsi(terminal.readOutput());
		expect(initial).toContain("› 1. Yes, proceed (y)");
		expect(initial).toContain("2. No, and tell Coda");
		expect(initial).toContain("Press enter to confirm or esc to cancel");

		terminal.clearOutput();
		await terminal.emit(key("page-down"));
		await tui.renderNow();
		const scrolled = stripAnsi(terminal.readOutput());
		expect(scrolled).toContain("› 2. No, and tell Coda");

		await terminal.emit(key("escape"));
		await pending;
		approval.unbind();
		await tui.stop();
	});

	it("cancels the Run on the numbered feedback choice so the composer can collect new guidance", async () => {
		const { terminal, root, tui, approval } = await setup();
		const pending = approval.decide(commandRequest("npm publish"));
		await terminal.emit(key("2"));
		await expect(pending).resolves.toEqual({ type: "abort" });
		expect(tui.focused).toBe(root);
		approval.unbind();
		await tui.stop();
	});

	it("preserves selection across resize and cancels from the selected feedback choice", async () => {
		const { terminal, tui, approval } = await setup();
		const pending = approval.decide(commandRequest());
		await terminal.emit(key("down"));
		await terminal.emit({ type: "resize", columns: 64, rows: 18 });
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("› 2. No, and tell Coda what to do differently (esc)");

		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});

	it("matches Codex list navigation aliases in approval choices", async () => {
		const { terminal, tui, approval } = await setup();
		const pending = approval.decide(commandRequest());

		await terminal.emit(key("j"));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("› 2. No, and tell Coda what to do differently (esc)");

		terminal.clearOutput();
		await terminal.emit(key("p", { control: true }));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("› 1. Yes, proceed (y)");

		await terminal.emit(key("n", { control: true }));
		await terminal.emit(key("k"));
		await terminal.emit(key("enter"));
		await expect(pending).resolves.toEqual({ type: "approved" });
		approval.unbind();
		await tui.stop();
	});

	it("preserves approval focus and selection across terminal suspend and resume", async () => {
		const { terminal, root, tui, approval } = await setup();
		const pending = approval.decide(commandRequest("npm publish"));
		await terminal.emit(key("up"));

		await tui.stop();
		terminal.clearOutput();
		await tui.start();
		await tui.renderNow();
		expect(tui.focused).not.toBe(root);
		expect(stripAnsi(terminal.readOutput())).toContain("› 2. No, and tell Coda what to do differently (esc)");
		await terminal.emit(key("escape"));
		await expect(pending).resolves.toEqual({ type: "abort" });
		approval.unbind();
		await tui.stop();
	});

	it("cancels the active and queued reviews together on Escape", async () => {
		const { terminal, tui, approval } = await setup();
		const first = approval.decide(commandRequest("first"));
		const second = approval.decide({
			...commandRequest("second"),
			invocationId: "invocation:queued-cancel" as ToolInvocationId,
		});

		await terminal.emit(key("escape"));
		await expect(first).resolves.toEqual({ type: "abort" });
		await expect(second).resolves.toEqual({ type: "abort" });
		terminal.clearOutput();
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).not.toContain("second");

		approval.unbind();
		await tui.stop();
	});

	it("resolves active and queued reviews as abort when the interactive handler is torn down", async () => {
		const { tui, approval } = await setup();
		const first = approval.decide(commandRequest("first"));
		const second = approval.decide({
			...commandRequest("second"),
			invocationId: "invocation:queued" as ToolInvocationId,
		});

		approval.unbind();
		await expect(first).resolves.toEqual({ type: "abort" });
		await expect(second).resolves.toEqual({ type: "abort" });
		await tui.stop();
	});
});
