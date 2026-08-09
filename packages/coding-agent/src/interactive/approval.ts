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
import type {
	ApprovalDecision,
	PermissionApprovalHandler,
	PermissionApprovalRequest,
} from "../permissions/permission-engine.ts";

interface ApprovalComponentOptions {
	readonly request: PermissionApprovalRequest;
	readonly finish: (decision: ApprovalDecision) => void;
}

function persistentCommandDecision(request: PermissionApprovalRequest): ApprovalDecision | undefined {
	return request.proposedCommandRule
		? { type: "approved-execpolicy-amendment", command: request.proposedCommandRule }
		: undefined;
}

function choiceFor(request: PermissionApprovalRequest, choice: string): ApprovalDecision | undefined {
	if (choice === "1") return { type: "approved" };
	if (request.kind === "network") {
		if (choice === "2") return { type: "approved-for-session" };
		if (choice === "3" && request.host) {
			return { type: "network-policy-amendment", host: request.host, action: "allow" };
		}
	}
	if (request.kind === "filesystem" && choice === "2") return { type: "approved-for-session" };
	if (request.kind === "command" && !request.additionalPermissions && choice === "2") {
		return persistentCommandDecision(request);
	}
	if (choice === "escape" || choice === "a") return { type: "abort" };
	return undefined;
}

function choices(request: PermissionApprovalRequest): string {
	const values = ["[1] approve once"];
	if (request.kind === "filesystem" || request.kind === "network") values.push("[2] approve for session");
	if (request.kind === "command" && !request.additionalPermissions && request.proposedCommandRule) {
		values.push("[2] save Command Rule");
	}
	if (request.kind === "network") values.push("[3] always allow host");
	values.push("[a] abort");
	return values.join("  ");
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
		if (!choice) return;
		const decision = choiceFor(this.#options.request, choice);
		if (decision) this.#options.finish(decision);
	}
}

interface PendingApproval {
	readonly handle: OverlayHandle;
	readonly resolve: (decision: ApprovalDecision) => void;
}

interface QueuedApproval {
	readonly request: PermissionApprovalRequest;
	readonly resolve: (decision: ApprovalDecision) => void;
	readonly reject: (error: unknown) => void;
}

export type ApprovalObserver = (request: PermissionApprovalRequest) => void;

export class InteractiveApprovalHandler implements PermissionApprovalHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#pending?: PendingApproval;
	readonly #queue: QueuedApproval[] = [];
	#observer?: ApprovalObserver;

	bind(tui: Tui, terminal: Terminal, observer?: ApprovalObserver): void {
		if (this.#tui && this.#tui !== tui) throw new Error("Approval handler is already bound to a TUI");
		this.#tui = tui;
		this.#terminal = terminal;
		this.#observer = observer;
	}

	unbind(): void {
		const decision = { type: "denied", rejection: "interactive approval closed" } as const;
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.handle.remove();
		pending?.resolve(decision);
		for (const queued of this.#queue.splice(0)) queued.resolve(decision);
		this.#tui = undefined;
		this.#terminal = undefined;
		this.#observer = undefined;
	}

	decide(request: PermissionApprovalRequest): Promise<ApprovalDecision> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.reject(new Error("Interactive approval is unavailable"));
		}
		this.#observer?.(request);
		return new Promise<ApprovalDecision>((resolve, reject) => {
			this.#queue.push({ request, resolve, reject });
			this.#showNext();
		});
	}

	#showNext(): void {
		if (this.#pending) return;
		const next = this.#queue.shift();
		if (!next) return;
		try {
			const component = new ApprovalComponent({
				request: next.request,
				finish: (decision) => this.#finish(decision),
			});
			const handle = this.#tui!.showOverlay(component, {
				layout: ({ columns, rows }) => approvalPlacement(next.request, columns, rows),
				focus: true,
			});
			this.#pending = { handle, resolve: next.resolve };
		} catch (error) {
			next.reject(error);
			this.#showNext();
		}
	}

	#finish(decision: ApprovalDecision): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		pending.handle.remove();
		pending.resolve(decision);
		this.#showNext();
	}
}

function approvalPlacement(request: PermissionApprovalRequest, columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(86, columns - 4);
	const maxHeight = Math.max(1, rows < 12 ? rows : rows - 4);
	const height = renderApprovalModal(request, width, maxHeight).length;
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}

function targetDescription(request: PermissionApprovalRequest): string {
	if (request.command) return `Command: ${request.command}`;
	if (request.kind === "network") {
		return `Destination: ${request.protocol ?? "https"}://${request.host ?? "unknown"}:${request.port ?? "default"}`;
	}
	return `Path: ${request.requestedPath ?? "(not provided)"} -> ${request.canonicalPath ?? "(unresolved)"}`;
}

function authorityDescription(request: PermissionApprovalRequest): string {
	if (request.sandboxPermissions === "require_escalated") return "Authority: Full Access for this exact command.";
	if (request.sandboxPermissions === "with_additional_permissions") {
		return `Authority: active Sandbox plus ${JSON.stringify(request.additionalPermissions)}`;
	}
	if (request.kind === "network") return "Authority: one managed-network destination.";
	if (request.kind === "filesystem") return "Authority: one exact filesystem operation.";
	return "Authority: active OS Sandbox; no implicit escalation.";
}

function grantDescription(request: PermissionApprovalRequest): string {
	if (request.kind === "network") {
		return "Grant: this request, this process session, or a persistent allow rule for the displayed host.";
	}
	if (request.kind === "filesystem") {
		return "Grant: this exact operation or this process session.";
	}
	if (request.additionalPermissions)
		return "Grant: this exact command with only the displayed additional permissions.";
	if (request.proposedCommandRule) {
		return "Grant: this exact command or the displayed persistent Command Rule.";
	}
	return "Grant: this exact command.";
}

function renderApprovalModal(request: PermissionApprovalRequest, width: number, maxHeight: number): string[] {
	if (width < 4 || maxHeight < 3) {
		return Array.from({ length: Math.max(1, maxHeight) }, (_, index) =>
			clipAnsi(index === 0 ? "Approval required" : index === maxHeight - 1 ? "Esc denies" : "", width),
		);
	}
	const innerWidth = width - 4;
	const wrapLine = (line: string): string[] => {
		const safe = sanitizeTerminalText(line).replace(/[\r\n]+/g, " ");
		return safe ? wrapAnsi(safe, innerWidth) : [""];
	};
	const header = wrapLine(`Approval required — ${request.kind}`);
	const optional = [
		request.reason,
		targetDescription(request),
		...(request.diff ? request.diff.split(/\r?\n/u) : []),
		...(request.justification ? [`Justification: ${request.justification}`] : []),
		`cwd: ${request.cwd}`,
	].flatMap(wrapLine);
	const required = [authorityDescription(request), grantDescription(request), "", choices(request)].flatMap(wrapLine);
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
			clipAnsi(authorityDescription(request), innerWidth),
			clipAnsi(grantDescription(request), innerWidth),
			clipAnsi(choices(request), innerWidth),
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
