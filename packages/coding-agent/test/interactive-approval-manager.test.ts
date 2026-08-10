import { Component, createSystemScheduler, stripAnsi, Tui, VirtualTerminal } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveApprovalManager } from "../src/interactive/approval-manager.ts";
import type { CommandSessionApproval } from "../src/permissions/permission-engine.ts";

class RootComponent extends Component {
	constructor() {
		super({ focusable: true });
	}

	render(): string[] {
		return ["chat"];
	}
}

function key(value: "a" | "d" | "down" | "escape") {
	return {
		type: "key" as const,
		key: value,
		text: value.length === 1 ? value : undefined,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press" as const,
	};
}

function approval(id: string, command: readonly string[]): CommandSessionApproval {
	return {
		id,
		command,
		environmentId: "local",
		cwd: "/workspace/coda",
		shellExecutable: "/bin/zsh",
		permissionProfile: "workspace",
		approvalPolicy: "on-request",
		sandboxPermissions: "require_escalated",
		executable: {
			path: `/usr/local/bin/${command[0]}`,
			device: "1",
			inode: id,
			size: 512,
			modifiedAt: 1_000,
		},
	};
}

describe("interactive Session Approval manager", () => {
	it("lists active grants and revokes the selected grant without closing", async () => {
		const terminal = new VirtualTerminal({ columns: 100, rows: 24 });
		const root = new RootComponent();
		const tui = new Tui({
			terminal,
			root,
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		await tui.start();
		let approvals = [approval("approval:1", ["npm", "test"]), approval("approval:2", ["git", "status"])];
		const revoke = vi.fn((id: string) => {
			const before = approvals.length;
			approvals = approvals.filter((candidate) => candidate.id !== id);
			return approvals.length !== before;
		});
		const manager = new InteractiveApprovalManager(tui, {
			listSessionApprovals: () => approvals,
			revokeSessionApproval: revoke,
			revokeAllSessionApprovals: () => 0,
		});

		const pending = manager.manage();
		await tui.renderNow();
		const initial = stripAnsi(terminal.readOutput());
		expect(initial).toContain("Active Session Approvals");
		expect(initial).toContain("npm test");
		expect(initial).toContain("git status");
		expect(initial).toContain("future matching commands only");

		await terminal.emit(key("down"));
		await terminal.emit(key("d"));
		expect(revoke).toHaveBeenCalledWith("approval:2");
		terminal.clearOutput();
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).not.toContain("git status");
		await terminal.emit(key("escape"));
		await expect(pending).resolves.toBeUndefined();
		expect(tui.focused).toBe(root);
		await tui.stop();
	});

	it("revokes every active grant with a and renders the empty state", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 20 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		await tui.start();
		let approvals = [approval("approval:1", ["npm", "test"])];
		const revokeAll = vi.fn(() => {
			const count = approvals.length;
			approvals = [];
			return count;
		});
		const manager = new InteractiveApprovalManager(tui, {
			listSessionApprovals: () => approvals,
			revokeSessionApproval: () => false,
			revokeAllSessionApprovals: revokeAll,
		});

		const pending = manager.manage();
		await terminal.emit(key("a"));
		await tui.renderNow();
		expect(revokeAll).toHaveBeenCalledOnce();
		expect(stripAnsi(terminal.readOutput())).toContain("No active Session Approvals");
		await terminal.emit(key("escape"));
		await pending;
		await tui.stop();
	});

	it("keeps the selected grant and management controls visible in a long list", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 20 });
		const tui = new Tui({
			terminal,
			root: new RootComponent(),
			clock: { now: () => 1_000 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		await tui.start();
		const approvals = Array.from({ length: 8 }, (_, index) =>
			approval(`approval:${index}`, [`command-${index}`, "run"]),
		);
		const manager = new InteractiveApprovalManager(tui, {
			listSessionApprovals: () => approvals,
			revokeSessionApproval: () => false,
			revokeAllSessionApprovals: () => 0,
		});

		const pending = manager.manage();
		await tui.renderNow();
		const initial = stripAnsi(terminal.takeOutput());
		expect(initial).toContain("[Esc] Close");
		expect(initial).not.toContain("command-7 run");

		for (let index = 0; index < 7; index += 1) await terminal.emit(key("down"));
		expect(stripAnsi(terminal.readOutput())).toContain("command-7 run");

		await terminal.emit(key("escape"));
		await pending;
		await tui.stop();
	});
});
