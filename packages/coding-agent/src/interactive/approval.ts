import {
	Component,
	type ComponentInputContext,
	clipAnsi,
	displayWidth,
	type OverlayHandle,
	type OverlayPlacement,
	type RenderContext,
	sanitizeTerminalText,
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

	render({ width, height }: RenderContext): string[] {
		return renderApprovalModal(this.#options.request, width, height);
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type === "resize" || input.type === "mouse") return;
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

export type ApprovalObserver = (request: ApprovalRequest) => void;

export class InteractiveApprovalHandler implements ApprovalHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#pending?: PendingApproval;
	#observer?: ApprovalObserver;

	bind(tui: Tui, terminal: Terminal, observer?: ApprovalObserver): void {
		if (this.#tui && this.#tui !== tui) throw new Error("Approval handler is already bound to a TUI");
		this.#tui = tui;
		this.#terminal = terminal;
		this.#observer = observer;
	}

	unbind(): void {
		this.#finish("deny");
		this.#tui = undefined;
		this.#terminal = undefined;
		this.#observer = undefined;
	}

	decide(request: ApprovalRequest): Promise<ApprovalDecision> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.reject(new Error("Interactive approval is unavailable"));
		}
		if (this.#pending) return Promise.reject(new Error("Another Tool approval is already pending"));
		this.#observer?.(request);
		return new Promise<ApprovalDecision>((resolve) => {
			const component = new ApprovalComponent({
				request,
				finish: (decision) => this.#finish(decision),
			});
			const handle = this.#tui!.showOverlay(component, {
				layout: ({ columns, rows }) => approvalPlacement(request, columns, rows),
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

function approvalPlacement(request: ApprovalRequest, columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(76, columns - 4);
	const maxHeight = Math.max(1, rows < 12 ? rows : rows - 4);
	const height = renderApprovalModal(request, width, maxHeight).length;
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}

function renderApprovalModal(request: ApprovalRequest, width: number, maxHeight: number): string[] {
	if (width < 4 || maxHeight < 3) {
		return Array.from({ length: Math.max(1, maxHeight) }, (_, index) =>
			clipAnsi(index === 0 ? "Approval required" : index === maxHeight - 1 ? "Esc denies" : "", width),
		);
	}
	const innerWidth = width - 4;
	const target = request.command
		? `Command: ${request.command}`
		: `Path: ${request.requestedPath ?? "(not provided)"} -> ${request.canonicalPath ?? "(unresolved)"}`;
	const scope =
		request.grantScope === "run"
			? "[1] allow once  [2] allow for Run  [d] deny  [a] deny + abort"
			: "[1] allow operation  [d] deny  [a] deny + abort";
	const wrapLine = (line: string): string[] => {
		const safe = sanitizeTerminalText(line).replace(/[\r\n]+/g, " ");
		return safe ? wrapAnsi(safe, innerWidth) : [""];
	};
	const header = wrapLine(`Approval required — ${request.toolName} (${request.operation})`);
	const optional = [
		describeReason(request),
		target,
		...(request.diff ? request.diff.split(/\r?\n/) : []),
		`cwd: ${request.cwd}`,
	].flatMap(wrapLine);
	const required = [
		request.hostAuthority
			? "Authority: host-user authority; no filesystem or network sandbox."
			: "Authority: restricted execution backend.",
		`Grant: ${request.grantScope === "run" ? "current Run" : "one exact operation"}`,
		"",
		scope,
	].flatMap(wrapLine);
	const available = maxHeight - 2;
	let body: string[];
	if (header.length + required.length <= available) {
		const optionalCapacity = available - header.length - required.length;
		const included = optional.slice(0, Math.max(0, optionalCapacity - (optional.length > optionalCapacity ? 1 : 0)));
		body = [
			...header,
			...included,
			...(included.length < optional.length ? [clipAnsi("… approval details omitted", innerWidth)] : []),
			...required,
		];
	} else {
		body = [
			clipAnsi(header.join(" "), innerWidth),
			clipAnsi(required.find((line) => line.startsWith("Authority:")) ?? "Authority: unavailable", innerWidth),
			clipAnsi(required.find((line) => line.startsWith("Grant:")) ?? "Grant: unavailable", innerWidth),
			clipAnsi(scope, innerWidth),
		].slice(0, available);
	}
	const top = `╭${"─".repeat(width - 2)}╮`;
	const bottom = `╰${"─".repeat(width - 2)}╯`;
	return [top, ...body.map((line) => borderedLine(line, innerWidth)), bottom];
}

function borderedLine(line: string, innerWidth: number): string {
	const clipped = clipAnsi(line, innerWidth);
	return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - displayWidth(clipped)))} │`;
}
