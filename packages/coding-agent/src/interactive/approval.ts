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
import { createCodaTheme, type ThemeSurfaceTone, type TuiTheme } from "./theme.ts";

const MINIMUM_APPROVAL_COLUMNS = 40;
const MINIMUM_APPROVAL_ROWS = 12;

const COPY = Object.freeze({
	prompt: "Would you like to run the following command?",
	footer: "Press enter to confirm or esc to cancel",
	tooSmall: "Approval pending — resize terminal",
});

type CommandChoiceId = "approve" | "session" | "feedback";

interface CommandChoice {
	readonly id: CommandChoiceId;
	readonly label: string;
	readonly shortcut: "y" | "p" | "esc";
}

interface ApprovalBarOptions {
	readonly request: PermissionApprovalRequest;
	readonly theme: TuiTheme;
	readonly terminalSize: () => Terminal["size"];
	readonly isReviewable: () => boolean;
	readonly finish: (decision: ApprovalDecision) => void;
}

function snapshotRequest(request: PermissionApprovalRequest): PermissionApprovalRequest {
	return Object.freeze({
		...request,
		commandWords: request.commandWords ? Object.freeze([...request.commandWords]) : undefined,
		requestedPaths: request.requestedPaths ? Object.freeze([...request.requestedPaths]) : undefined,
		canonicalPaths: request.canonicalPaths ? Object.freeze([...request.canonicalPaths]) : undefined,
		proposedCommandRule: request.proposedCommandRule ? Object.freeze([...request.proposedCommandRule]) : undefined,
		proposedSessionCommandRule: request.proposedSessionCommandRule
			? Object.freeze([...request.proposedSessionCommandRule])
			: undefined,
		executableIdentity: request.executableIdentity ? Object.freeze({ ...request.executableIdentity }) : undefined,
		additionalPermissions: request.additionalPermissions
			? Object.freeze({
					network: request.additionalPermissions.network
						? Object.freeze({ ...request.additionalPermissions.network })
						: undefined,
					file_system: request.additionalPermissions.file_system
						? Object.freeze({
								read: request.additionalPermissions.file_system.read
									? Object.freeze([...request.additionalPermissions.file_system.read])
									: undefined,
								write: request.additionalPermissions.file_system.write
									? Object.freeze([...request.additionalPermissions.file_system.write])
									: undefined,
							})
						: undefined,
				})
			: undefined,
	});
}

function visibleUntrustedText(value: string): string {
	let output = "";
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (character === "\n") {
			output += character;
			continue;
		}
		if (
			code < 0x20 ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			output += `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
			continue;
		}
		output += character;
	}
	return sanitizeTerminalText(output);
}

function commandChoices(request: PermissionApprovalRequest): readonly CommandChoice[] {
	const choices: CommandChoice[] = [{ id: "approve", label: "Yes, proceed", shortcut: "y" }];
	if (request.proposedSessionCommandRule && request.executableIdentity) {
		const renderedPrefix = visibleUntrustedText(request.proposedSessionCommandRule.join(" "));
		choices.push({
			id: "session",
			label: `Yes, and don't ask again for commands that start with \`${renderedPrefix}\``,
			shortcut: "p",
		});
	}
	choices.push({
		id: "feedback",
		label: "No, and tell Coda what to do differently",
		shortcut: "esc",
	});
	return Object.freeze(choices);
}

interface ApprovalSpan {
	readonly value: string;
	readonly tone?: ThemeSurfaceTone;
}

interface ApprovalLogicalLine {
	readonly spans: readonly ApprovalSpan[];
}

function logicalLine(...spans: ApprovalSpan[]): ApprovalLogicalLine {
	return { spans };
}

function permissionRule(request: PermissionApprovalRequest): string | undefined {
	const permissions = request.additionalPermissions;
	if (!permissions) return undefined;
	const parts: string[] = [];
	if (permissions.network?.enabled) parts.push("network");
	const reads = permissions.file_system?.read?.map((path) => `\`${visibleUntrustedText(path)}\``) ?? [];
	if (reads.length > 0) parts.push(`read ${reads.join(", ")}`);
	const writes = permissions.file_system?.write?.map((path) => `\`${visibleUntrustedText(path)}\``) ?? [];
	if (writes.length > 0) parts.push(`write ${writes.join(", ")}`);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

function commandHeaderLines(request: PermissionApprovalRequest): readonly ApprovalLogicalLine[] {
	const lines: ApprovalLogicalLine[] = [logicalLine({ value: COPY.prompt, tone: "strong" }), logicalLine()];
	if (request.environmentId) {
		lines.push(
			logicalLine(
				{ value: "Environment: " },
				{ value: visibleUntrustedText(request.environmentId), tone: "strong" },
			),
			logicalLine(),
		);
	}
	if (request.reason.trim().length > 0) {
		lines.push(
			logicalLine({ value: "Reason: " }, { value: visibleUntrustedText(request.reason), tone: "emphasis" }),
			logicalLine(),
		);
	}
	const rule = permissionRule(request);
	if (rule) {
		lines.push(logicalLine({ value: "Permission rule: " }, { value: rule, tone: "code" }), logicalLine());
	}
	const command = visibleUntrustedText(request.command ?? "(command unavailable)");
	for (const [index, commandLine] of command.split("\n").entries()) {
		lines.push(
			logicalLine(
				{ value: index === 0 ? "$ " : "" },
				{ value: commandLine.length > 0 ? commandLine : " ", tone: "code" },
			),
		);
	}
	return Object.freeze(lines);
}

function plainLogicalLines(lines: readonly ApprovalLogicalLine[], width: number): string[] {
	return lines.flatMap((line) => wrapAnsi(line.spans.map((span) => span.value).join(""), Math.max(1, width)));
}

function renderLogicalLines(
	theme: TuiTheme,
	lines: readonly ApprovalLogicalLine[],
	innerWidth: number,
	outerWidth: number,
): string[] {
	const leftInset = Math.min(2, Math.max(0, outerWidth - 1));
	return lines.flatMap((line) => {
		const styled = line.spans
			.map((span) => theme.styleOnSurface("panel", span.tone ?? "normal", span.value))
			.join("");
		return wrapAnsi(styled, Math.max(1, innerWidth)).map((wrapped) => {
			const left = theme.styleOnSurface("panel", "normal", " ".repeat(leftInset));
			const rightWidth = Math.max(0, outerWidth - leftInset - displayWidth(wrapped));
			const right = theme.styleOnSurface("panel", "normal", " ".repeat(rightWidth));
			return `${left}${wrapped}${right}`;
		});
	});
}

function wrapChoice(choice: CommandChoice, index: number, selected: boolean, width: number): string[] {
	const prefix = `${selected ? "›" : " "} ${index + 1}. `;
	const label = `${visibleUntrustedText(choice.label)} (${choice.shortcut})`;
	if (displayWidth(prefix) >= width) return wrapAnsi(`${prefix}${label}`, Math.max(1, width));
	const indent = " ".repeat(displayWidth(prefix));
	const labelLines = wrapAnsi(label, Math.max(1, width - displayWidth(prefix)));
	return labelLines.map((line, lineIndex) => `${lineIndex === 0 ? prefix : indent}${line}`);
}

function paddedLine(value: string, width: number): string {
	const clipped = clipAnsi(value, width);
	return `${clipped}${" ".repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function surfaceLine(theme: TuiTheme, value: string, width: number, tone: ThemeSurfaceTone = "normal"): string {
	return theme.styleOnSurface("panel", tone, paddedLine(value, width));
}

function approvalDesiredHeight(request: PermissionApprovalRequest, columns: number): number {
	const innerWidth = Math.max(1, columns - 4);
	const headerHeight = plainLogicalLines(commandHeaderLines(request), innerWidth).length;
	const choicesHeight = commandChoices(request).reduce(
		(total, choice, index) => total + wrapChoice(choice, index, index === 0, Math.max(1, columns)).length,
		0,
	);
	const footerHeight = wrapAnsi(`  ${COPY.footer}`, Math.max(1, columns)).length;
	return 2 + headerHeight + 1 + choicesHeight + footerHeight;
}

function approvalBarHeight(request: PermissionApprovalRequest, columns: number, rows: number): number {
	if (columns < MINIMUM_APPROVAL_COLUMNS || rows < MINIMUM_APPROVAL_ROWS) return Math.min(rows, 6);
	return Math.min(rows, approvalDesiredHeight(request, columns));
}

class CommandApprovalBar extends Component {
	readonly #options: ApprovalBarOptions;
	#selected = 0;
	#detailsScroll = 0;

	constructor(options: ApprovalBarOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	render({ width, height }: RenderContext): string[] {
		if (width < MINIMUM_APPROVAL_COLUMNS || height < Math.min(MINIMUM_APPROVAL_ROWS, 7)) {
			return this.#renderTooSmall(width, height);
		}
		return this.#renderDecisions(width, height);
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		if (input.type === "resize") return;
		if (input.type === "mouse") return;
		if (input.type === "key" && input.action !== "release" && input.control && input.key === "c") {
			this.#options.finish({ type: "abort" });
			return;
		}
		if (input.type !== "key" || input.action === "release") return;
		if (input.key === "escape") {
			this.#options.finish({ type: "abort" });
			return;
		}
		if (!this.#options.isReviewable()) {
			if (input.key === "page-up" || input.key === "page-down" || input.key === "home" || input.key === "end") {
				if (input.key === "home") this.#detailsScroll = 0;
				else if (input.key === "end") this.#detailsScroll = Number.MAX_SAFE_INTEGER;
				else this.#detailsScroll += input.key === "page-up" ? -5 : 5;
				this.#detailsScroll = Math.max(0, this.#detailsScroll);
				this.invalidate();
				context.requestImmediateRender();
			}
			return;
		}
		const choices = commandChoices(this.#options.request);
		const unshiftedListKey = !input.shift && !input.alt && !input.meta;
		const moveUp =
			input.key === "up" || (unshiftedListKey && (input.key === "k" || (input.control && input.key === "p")));
		const moveDown =
			input.key === "down" || (unshiftedListKey && (input.key === "j" || (input.control && input.key === "n")));
		if (moveUp || moveDown) {
			this.#selected = (this.#selected + (moveDown ? 1 : -1) + choices.length) % choices.length;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "page-up" || input.key === "home") {
			this.#selected = 0;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "page-down" || input.key === "end") {
			this.#selected = choices.length - 1;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "enter") {
			this.#activate(choices[this.#selected]!);
			return;
		}
		if (input.control || input.alt || input.meta) return;
		if (input.key === "y") {
			this.#activate(choices[0]!);
			return;
		}
		const session = choices.find((choice) => choice.id === "session");
		if (input.key === "p" && session) {
			this.#activate(session);
			return;
		}
		if (/^[1-9]$/u.test(input.key)) {
			const choice = choices[Number(input.key) - 1];
			if (choice) this.#activate(choice);
		}
	}

	#activate(choice: CommandChoice): void {
		if (choice.id === "approve") {
			this.#options.finish({ type: "approved" });
			return;
		}
		if (choice.id === "session") {
			this.#options.finish({
				type: "approved-command-prefix-for-session",
				command: this.#options.request.proposedSessionCommandRule!,
			});
			return;
		}
		this.#options.finish({ type: "abort" });
	}

	#renderTooSmall(width: number, height: number): string[] {
		if (height <= 0) return [];
		const safeWidth = Math.max(1, width);
		const terminalSize = this.#options.terminalSize();
		const helpRows = wrapAnsi("PgUp/PgDn scroll • Esc cancel • Ctrl-C abort", safeWidth).slice(
			0,
			Math.max(0, height - 1),
		);
		const contentRows = Math.max(0, height - 1 - helpRows.length);
		const detailHeight = Math.max(0, contentRows - 1);
		const details = plainLogicalLines(commandHeaderLines(this.#options.request), safeWidth);
		const maximumScroll = Math.max(0, details.length - detailHeight);
		this.#detailsScroll = Math.min(this.#detailsScroll, maximumScroll);
		const visibleDetails = details.slice(this.#detailsScroll, this.#detailsScroll + detailHeight);
		const position =
			detailHeight > 0 && details.length > detailHeight
				? ` • details ${this.#detailsScroll + 1}–${this.#detailsScroll + visibleDetails.length}/${details.length}`
				: "";
		const lines = [
			`• ${COPY.tooSmall}`,
			...(contentRows > 0
				? [
						`Current size: ${terminalSize.columns}×${terminalSize.rows}; requires ${MINIMUM_APPROVAL_COLUMNS}×${MINIMUM_APPROVAL_ROWS}${position}`,
					]
				: []),
			...visibleDetails,
			...helpRows,
		].slice(0, height);
		while (lines.length < height) lines.push("");
		return lines.map((line, index) =>
			surfaceLine(this.#options.theme, line, width, index === 0 ? "warning" : "normal"),
		);
	}

	#renderDecisions(width: number, height: number): string[] {
		const choices = commandChoices(this.#options.request);
		const choiceRows = choices.map((choice, index) => {
			return {
				selected: this.#selected === index,
				lines: wrapChoice(choice, index, this.#selected === index, width),
			};
		});
		const choiceLineCount = choiceRows.reduce((total, choice) => total + choice.lines.length, 0);
		const innerWidth = Math.max(1, width - 4);
		const details = renderLogicalLines(
			this.#options.theme,
			commandHeaderLines(this.#options.request),
			innerWidth,
			width,
		);
		const helpRows = wrapAnsi(`  ${COPY.footer}`, width);
		const bodyHeight = Math.max(0, height - helpRows.length);
		const fixedBodyRows = choiceLineCount + 3;
		const detailHeight = Math.max(1, bodyHeight - fixedBodyRows);
		const maximumScroll = Math.max(0, details.length - detailHeight);
		this.#detailsScroll = Math.min(this.#detailsScroll, maximumScroll);
		const visibleDetails = details.slice(this.#detailsScroll, this.#detailsScroll + detailHeight);
		const frame = [surfaceLine(this.#options.theme, "", width)];
		for (const detail of visibleDetails) frame.push(detail);
		frame.push(surfaceLine(this.#options.theme, "", width));
		for (const choice of choiceRows) {
			for (const line of choice.lines) {
				frame.push(surfaceLine(this.#options.theme, line, width, choice.selected ? "accent" : "normal"));
			}
		}
		frame.push(surfaceLine(this.#options.theme, "", width));
		for (const help of helpRows) frame.push(this.#options.theme.style("muted", paddedLine(help, width)));
		while (frame.length < height)
			frame.splice(frame.length - helpRows.length, 0, surfaceLine(this.#options.theme, "", width));
		return frame.slice(0, height);
	}
}

interface LegacyApprovalOptions {
	readonly request: PermissionApprovalRequest;
	readonly finish: (decision: ApprovalDecision) => void;
}

function legacyChoiceFor(request: PermissionApprovalRequest, choice: string): ApprovalDecision | undefined {
	if (choice === "1") return { type: "approved" };
	if ((request.kind === "network" || request.kind === "filesystem") && choice === "2") {
		return { type: "approved-for-session" };
	}
	if (request.kind === "network" && choice === "3" && request.host) {
		return { type: "network-policy-amendment", host: request.host, action: "allow" };
	}
	if (choice === "escape" || choice === "a") return { type: "abort" };
	return undefined;
}

function legacyChoices(request: PermissionApprovalRequest): string {
	const values = ["[1] approve once"];
	if (request.kind === "filesystem" || request.kind === "network") values.push("[2] approve for session");
	if (request.kind === "network") values.push("[3] always allow host");
	values.push("[a] abort");
	return values.join("  ");
}

class LegacyApprovalComponent extends Component {
	readonly #options: LegacyApprovalOptions;

	constructor(options: LegacyApprovalOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	render({ width, height }: RenderContext): string[] {
		return renderLegacyApproval(this.#options.request, width, height);
	}

	handleInput(input: TerminalInput): void {
		if (input.type === "resize" || input.type === "mouse" || input.type === "paste") return;
		let choice: string | undefined;
		if (input.type === "text") choice = input.text.trim().toLowerCase()[0];
		else if (input.action !== "release") choice = input.key;
		if (!choice) return;
		const decision = legacyChoiceFor(this.#options.request, choice);
		if (decision) this.#options.finish(decision);
	}
}

interface PendingApproval {
	readonly handle: OverlayHandle;
	readonly component: Component;
	readonly resolve: (decision: ApprovalDecision) => void;
	readonly sessionId?: string;
}

interface QueuedApproval {
	readonly request: PermissionApprovalRequest;
	readonly resolve: (decision: ApprovalDecision) => void;
	readonly reject: (error: unknown) => void;
	readonly sessionId?: string;
}

export type ApprovalObserver = (request: PermissionApprovalRequest, sessionId?: string) => void;

export class InteractiveApprovalHandler implements PermissionApprovalHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#pending?: PendingApproval;
	readonly #queue: QueuedApproval[] = [];
	#observer?: ApprovalObserver;
	#activeSessionId?: string;

	get pendingSessionIds(): readonly string[] {
		return Object.freeze([
			...new Set([this.#pending?.sessionId, ...this.#queue.map(({ sessionId }) => sessionId)].filter(isString)),
		]);
	}

	bind(tui: Tui, terminal: Terminal, observer?: ApprovalObserver): void {
		if (this.#tui && this.#tui !== tui) throw new Error("Approval handler is already bound to a TUI");
		this.#tui = tui;
		this.#terminal = terminal;
		this.#observer = observer;
	}

	forSession(sessionId: string): PermissionApprovalHandler {
		if (!sessionId) throw new Error("Approval Session identity must not be empty");
		return Object.freeze({ decide: (request: PermissionApprovalRequest) => this.#decide(request, sessionId) });
	}

	setActiveSession(sessionId: string): void {
		if (!sessionId) throw new Error("Active approval Session identity must not be empty");
		this.#activeSessionId = sessionId;
		this.#showNext();
	}

	unbind(): void {
		const decision = { type: "abort" } as const;
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.handle.remove();
		pending?.resolve(decision);
		for (const queued of this.#queue.splice(0)) queued.resolve(decision);
		this.#tui = undefined;
		this.#terminal = undefined;
		this.#observer = undefined;
		this.#activeSessionId = undefined;
	}

	decide(request: PermissionApprovalRequest): Promise<ApprovalDecision> {
		return this.#decide(request);
	}

	#decide(request: PermissionApprovalRequest, sessionId?: string): Promise<ApprovalDecision> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.reject(new Error("Interactive approval is unavailable"));
		}
		const snapshot = snapshotRequest(request);
		this.#observer?.(snapshot, sessionId);
		return new Promise<ApprovalDecision>((resolve, reject) => {
			this.#queue.push({ request: snapshot, resolve, reject, sessionId });
			this.#pending?.component.invalidate();
			this.#showNext();
		});
	}

	#showNext(): void {
		if (this.#pending) return;
		const index = this.#queue.findIndex(
			({ sessionId }) => sessionId === undefined || sessionId === this.#activeSessionId,
		);
		const next = index < 0 ? undefined : this.#queue.splice(index, 1)[0];
		if (!next) return;
		try {
			const component =
				next.request.kind === "command"
					? new CommandApprovalBar({
							request: next.request,
							theme: createCodaTheme(
								this.#terminal!.capabilities.colorLevel,
								this.#terminal!.capabilities.appearance,
							),
							terminalSize: () => this.#terminal!.size,
							isReviewable: () =>
								this.#terminal!.size.columns >= MINIMUM_APPROVAL_COLUMNS &&
								this.#terminal!.size.rows >= MINIMUM_APPROVAL_ROWS,
							finish: (decision) => this.#finish(decision),
						})
					: new LegacyApprovalComponent({
							request: next.request,
							finish: (decision) => this.#finish(decision),
						});
			const handle = this.#tui!.showOverlay(component, {
				layout: ({ columns, rows }) =>
					next.request.kind === "command"
						? approvalBarPlacement(next.request, columns, rows)
						: legacyApprovalPlacement(next.request, columns, rows),
				focus: true,
			});
			this.#pending = { handle, component, resolve: next.resolve, sessionId: next.sessionId };
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
		if (decision.type === "abort") {
			for (const queued of this.#queue.splice(0)) queued.resolve(decision);
			return;
		}
		this.#showNext();
	}
}

function isString(value: string | undefined): value is string {
	return value !== undefined;
}

function approvalBarPlacement(request: PermissionApprovalRequest, columns: number, rows: number): OverlayPlacement {
	const height = approvalBarHeight(request, columns, rows);
	return { row: rows - height, column: 0, width: columns, height };
}

function legacyApprovalPlacement(request: PermissionApprovalRequest, columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(86, columns - 4);
	const maxHeight = Math.max(1, rows < 12 ? rows : rows - 4);
	const height = renderLegacyApproval(request, width, maxHeight).length;
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}

function legacyTarget(request: PermissionApprovalRequest): string {
	if (request.kind === "network") {
		return `Destination: ${request.protocol ?? "https"}://${request.host ?? "unknown"}:${request.port ?? "default"}`;
	}
	if (request.requestedPaths || request.canonicalPaths) {
		const requested = request.requestedPaths ?? [];
		const canonical = request.canonicalPaths ?? [];
		const targets = Array.from(
			{ length: Math.max(requested.length, canonical.length) },
			(_, index) => `${requested[index] ?? "(not provided)"} -> ${canonical[index] ?? "(unresolved)"}`,
		);
		return `Targets (${targets.length}): ${targets.join(", ")}`;
	}
	return `Path: ${request.requestedPath ?? "(not provided)"} -> ${request.canonicalPath ?? "(unresolved)"}`;
}

function renderLegacyApproval(request: PermissionApprovalRequest, width: number, maxHeight: number): string[] {
	if (width < 4 || maxHeight < 3) {
		return Array.from({ length: Math.max(1, maxHeight) }, (_, index) =>
			clipAnsi(index === 0 ? "Approval required" : index === maxHeight - 1 ? "Esc aborts" : "", width),
		);
	}
	const innerWidth = width - 4;
	const wrapLine = (line: string): string[] => {
		const safe = visibleUntrustedText(line).replace(/[\r\n]+/gu, " ");
		return safe ? wrapAnsi(safe, innerWidth) : [""];
	};
	const preview = request.diff
		? request.diff
				.split(/\r?\n/gu)
				.flatMap((line, index) => wrapLine(`${index === 0 ? "Patch preview: " : ""}${line}`))
		: [];
	const choices = wrapLine(legacyChoices(request));
	const availableBodyRows = Math.max(0, maxHeight - 2 - choices.length);
	const body = [
		...wrapLine(`Approval required — ${request.kind}`),
		...wrapLine(request.reason),
		...wrapLine(legacyTarget(request)),
		...wrapLine(`cwd: ${request.cwd}`),
		...preview,
	].slice(0, availableBodyRows);
	body.push(...choices.slice(0, Math.max(0, maxHeight - 2 - body.length)));
	return [
		`╭${"─".repeat(width - 2)}╮`,
		...body.map((line) => {
			const clipped = clipAnsi(line, innerWidth);
			return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - displayWidth(clipped)))} │`;
		}),
		`╰${"─".repeat(width - 2)}╯`,
	];
}
