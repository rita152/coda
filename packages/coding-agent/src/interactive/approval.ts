import {
	Component,
	type ComponentInputContext,
	type OverlayHandle,
	type Terminal,
	type TerminalInput,
	type Tui,
	wrapAnsi,
} from "@coda/tui";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "../policy.ts";

interface ApprovalComponentOptions {
	readonly request: ApprovalRequest;
	readonly finish: (decision: ApprovalDecision) => void;
}

function describeReason(request: ApprovalRequest): string {
	switch (request.reason) {
		case "outside_workspace":
			return "The requested path resolves outside the Workspace.";
		case "protected_path":
			return "The requested path is protected and may contain secrets or repository metadata.";
		case "shell":
			return "This command can read, write, execute, and access the network as your host user.";
	}
}

class ApprovalComponent extends Component {
	readonly #options: ApprovalComponentOptions;

	constructor(options: ApprovalComponentOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	render(width: number): string[] {
		const request = this.#options.request;
		const target = request.command
			? `Command: ${request.command}`
			: `Path: ${request.requestedPath ?? "(not provided)"} -> ${request.canonicalPath ?? "(unresolved)"}`;
		const scope =
			request.grantScope === "run"
				? "[1] allow once  [2] allow for this Run  [d] deny  [a] deny + abort"
				: "[1] allow this exact operation  [d] deny  [a] deny + abort";
		const lines = [
			`Approval required: ${request.toolName} (${request.operation})`,
			describeReason(request),
			target,
			...(request.diff ? [request.diff] : []),
			`cwd: ${request.cwd}`,
			request.hostAuthority
				? "Authority: host-user authority; no filesystem or network sandbox."
				: "Authority: restricted execution backend.",
			`Grant: ${request.grantScope === "run" ? "current Run" : "one exact operation"}`,
			scope,
		];
		return lines.flatMap((line) => wrapAnsi(line, width));
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type === "resize") return;
		let choice: string | undefined;
		if (input.type === "text" || input.type === "paste") choice = input.text.trim().toLowerCase()[0];
		else if (input.action !== "release") choice = input.key;
		if (choice === "1") {
			this.#options.finish("allow_once");
			return;
		}
		if (choice === "2") {
			this.#options.finish(this.#options.request.grantScope === "run" ? "allow_run" : "allow_once");
			return;
		}
		if (choice === "d" || choice === "escape") {
			this.#options.finish("deny");
			return;
		}
		if (choice === "a") this.#options.finish("deny_and_abort");
	}
}

interface PendingApproval {
	readonly handle: OverlayHandle;
	readonly resolve: (decision: ApprovalDecision) => void;
}

export class InteractiveApprovalHandler implements ApprovalHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#pending?: PendingApproval;

	bind(tui: Tui, terminal: Terminal): void {
		if (this.#tui && this.#tui !== tui) throw new Error("Approval handler is already bound to a TUI");
		this.#tui = tui;
		this.#terminal = terminal;
	}

	unbind(): void {
		this.#finish("deny");
		this.#tui = undefined;
		this.#terminal = undefined;
	}

	decide(request: ApprovalRequest): Promise<ApprovalDecision> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.reject(new Error("Interactive approval is unavailable"));
		}
		if (this.#pending) return Promise.reject(new Error("Another Tool approval is already pending"));
		return new Promise<ApprovalDecision>((resolve) => {
			const component = new ApprovalComponent({
				request,
				finish: (decision) => this.#finish(decision),
			});
			const handle = this.#tui!.showOverlay(component, {
				row: 1,
				column: 0,
				width: this.#terminal!.size.columns,
				focus: true,
			});
			this.#pending = { handle, resolve };
		});
	}

	#finish(decision: ApprovalDecision): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		pending.handle.remove();
		pending.resolve(decision);
	}
}
