import {
	Component,
	type ComponentInputContext,
	clipAnsi,
	displayWidth,
	type OverlayHandle,
	type OverlayPlacement,
	type RenderContext,
	sanitizeTerminalText,
	type TerminalInput,
	type Tui,
	wrapAnsi,
} from "@coda/tui";
import type { PermissionEngine } from "../permissions/permission-engine.ts";

export type SessionApprovalManagement = Pick<
	PermissionEngine,
	"listSessionApprovals" | "revokeSessionApproval" | "revokeAllSessionApprovals"
>;

interface ApprovalManagerOverlayOptions {
	readonly management: SessionApprovalManagement;
	readonly finish: () => void;
}

class ApprovalManagerOverlay extends Component {
	readonly #options: ApprovalManagerOverlayOptions;
	#selected = 0;

	constructor(options: ApprovalManagerOverlayOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	render({ width, height }: RenderContext): string[] {
		const approvals = this.#options.management.listSessionApprovals();
		this.#selected = Math.max(0, Math.min(this.#selected, approvals.length - 1));
		return renderApprovalManager(approvals, this.#selected, width, height);
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		if (input.type === "resize" || input.type === "mouse" || input.type === "paste" || input.type === "text") {
			return;
		}
		if (input.action === "release") return;
		if (input.key === "escape") {
			this.#options.finish();
			return;
		}
		const approvals = this.#options.management.listSessionApprovals();
		if (input.key === "up" || input.key === "down") {
			if (approvals.length > 0) {
				this.#selected = (this.#selected + (input.key === "down" ? 1 : -1) + approvals.length) % approvals.length;
				this.invalidate();
				context.requestImmediateRender();
			}
			return;
		}
		if (input.key === "d" || input.key === "delete" || input.key === "backspace") {
			const selected = approvals[this.#selected];
			if (selected) this.#options.management.revokeSessionApproval(selected.id);
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "a") {
			this.#options.management.revokeAllSessionApprovals();
			this.#selected = 0;
			this.invalidate();
			context.requestImmediateRender();
		}
	}
}

export class InteractiveApprovalManager {
	readonly #tui: Tui;
	readonly #management: SessionApprovalManagement;
	#pending?: OverlayHandle;

	constructor(tui: Tui, management: SessionApprovalManagement) {
		this.#tui = tui;
		this.#management = management;
	}

	manage(): Promise<void> {
		if (!this.#tui.started) return Promise.reject(new Error("Session Approval manager requires an active TUI"));
		if (this.#pending) return Promise.reject(new Error("Session Approval manager is already open"));
		return new Promise<void>((resolve) => {
			const finish = () => {
				this.#pending?.remove();
				this.#pending = undefined;
				resolve();
			};
			const component = new ApprovalManagerOverlay({ management: this.#management, finish });
			this.#pending = this.#tui.showOverlay(component, {
				focus: true,
				layout: ({ columns, rows }) => approvalManagerPlacement(columns, rows),
			});
		});
	}
}

function approvalManagerPlacement(columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(96, columns - 4);
	const height = Math.max(1, Math.min(rows < 12 ? rows : rows - 4, 18));
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}

function approvalEntryLines(
	approvals: ReturnType<SessionApprovalManagement["listSessionApprovals"]>,
	selected: number,
	width: number,
): readonly (readonly string[])[] {
	return approvals.map((approval, index) => {
		const marker = index === selected ? "›" : " ";
		return [
			...wrapAnsi(sanitizeTerminalText(`${marker} ${approval.command.join(" ")}`).replace(/[\r\n]+/gu, " "), width),
			...wrapAnsi(
				sanitizeTerminalText(
					`    ${approval.permissionProfile} / ${approval.approvalPolicy} / ${approval.sandboxPermissions}`,
				).replace(/[\r\n]+/gu, " "),
				width,
			),
			...wrapAnsi(sanitizeTerminalText(`    ${approval.executable.path}`).replace(/[\r\n]+/gu, " "), width),
		];
	});
}

function visibleApprovalLines(entries: readonly (readonly string[])[], selected: number, height: number): string[] {
	if (height <= 0 || entries.length === 0) return [];
	let start = selected;
	let used = Math.min(entries[selected]?.length ?? 0, height);
	while (start > 0 && used + entries[start - 1]!.length <= height) {
		start -= 1;
		used += entries[start]!.length;
	}
	let end = selected + 1;
	while (end < entries.length && used + entries[end]!.length <= height) {
		used += entries[end]!.length;
		end += 1;
	}
	return entries.slice(start, end).flat().slice(0, height);
}

function renderApprovalManager(
	approvals: ReturnType<SessionApprovalManagement["listSessionApprovals"]>,
	selected: number,
	width: number,
	height: number,
): string[] {
	if (width < 4 || height < 3) return [clipAnsi("Active Session Approvals", width)];
	const innerWidth = width - 4;
	const contentHeight = height - 2;
	const header = [
		...wrapAnsi("Active Session Approvals", innerWidth),
		...wrapAnsi("Revocation affects future matching commands only; running commands are unchanged.", innerWidth),
		"",
	];
	const footer = [
		"",
		...(approvals.length > 0 ? wrapAnsi("[↑/↓] select  [d/Delete] revoke  [a] revoke all", innerWidth) : []),
		...wrapAnsi("[Esc] Close", innerWidth),
	];
	const reservedFooter = footer.slice(-Math.min(footer.length, contentHeight));
	const visibleHeader = header.slice(0, Math.max(0, contentHeight - reservedFooter.length));
	const bodyHeight = Math.max(0, contentHeight - visibleHeader.length - reservedFooter.length);
	const body =
		approvals.length === 0
			? ["No active Session Approvals.", "New grants can be created from command Approval Requests."]
					.flatMap((line) => wrapAnsi(line, innerWidth))
					.slice(0, bodyHeight)
			: visibleApprovalLines(approvalEntryLines(approvals, selected, innerWidth), selected, bodyHeight);
	const content = [...visibleHeader, ...body];
	while (content.length < contentHeight - reservedFooter.length) content.push("");
	content.push(...reservedFooter);
	return [
		`╭${"─".repeat(width - 2)}╮`,
		...content.map((line) => {
			const clipped = clipAnsi(line, innerWidth);
			return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - displayWidth(clipped)))} │`;
		}),
		`╰${"─".repeat(width - 2)}╯`,
	];
}
