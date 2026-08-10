import { Component, createSystemScheduler, ProcessTerminal, Tui } from "@coda/tui";
import { InteractiveApprovalHandler } from "../../../dist/interactive/approval.js";

class ApprovalSmokeRoot extends Component {
	constructor() {
		super({ focusable: true });
	}

	render() {
		return ["PTY approval smoke"];
	}
}

const scheduler = createSystemScheduler();
const terminal = new ProcessTerminal({
	input: process.stdin,
	output: process.stdout,
	environment: process.env,
	scheduler,
	colorScheme: "dark",
});
const tui = new Tui({
	terminal,
	root: new ApprovalSmokeRoot(),
	clock: { now: () => Date.now() },
	scheduler,
	keybindings: [],
});
const approval = new InteractiveApprovalHandler();

if (!(await tui.start())) throw new Error("PTY terminal is unavailable");
approval.bind(tui, terminal);
let decision;
try {
	decision = await approval.decide({
		kind: "command",
		runId: "run:pty-approval",
		turnId: "turn:pty-approval",
		invocationId: "invocation:pty-approval",
		toolName: "bash",
		reason: "verify the real pseudo-terminal Approval Bar",
		command: "npm test -- --runInBand",
		commandWords: ["npm", "test", "--", "--runInBand"],
		cwd: process.env.CODA_E2E_WORKSPACE,
		environmentId: "local",
		sandboxPermissions: "use_default",
		proposedSessionCommandRule: ["npm", "test"],
		executableIdentity: {
			path: "/usr/local/bin/npm",
			device: "1",
			inode: "42",
			size: 512,
			modifiedAt: 1_000,
		},
	});
} finally {
	approval.unbind();
	await tui.stop();
}
process.stdout.write(`\nCODA_E2E_APPROVAL_RESULT=${JSON.stringify(decision)}\n`);
