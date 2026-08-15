import {
	clipAnsi,
	displayWidth,
	type ImagePlacement,
	type RenderContext,
	sanitizeTerminalText,
	type TerminalInput,
} from "@coda/tui";
import type { ChatAttachment } from "./chat-component.ts";
import { attachmentTargetKey, type LocalAttachmentHitRegion, previewGeometry } from "./chat-rendering.ts";
import type { TimelineProvisionalCard, TimelineRecoverableCard } from "./chat-timeline-renderer.ts";
import type { TimelineEntry } from "./semantic-timeline.ts";
import type { TuiTheme } from "./theme.ts";

export interface ChatAttachmentProjection {
	readonly timelineEntries: readonly TimelineEntry[];
	readonly provisionalCards: readonly TimelineProvisionalCard[];
	readonly recoverableCards: readonly TimelineRecoverableCard[];
	readonly activeFollowUp?: TimelineRecoverableCard;
}

export interface AttachmentTarget {
	readonly key: string;
	readonly source: "composer" | "timeline";
	readonly attachment: ChatAttachment;
	readonly composerIndex?: number;
}

export interface ChatAttachmentView {
	readonly staged: readonly ChatAttachment[];
	readonly focusKey?: string;
	readonly imageModal: boolean;
	readonly focusedTarget?: AttachmentTarget;
	readonly focusedAttachment?: ChatAttachment;
	readonly messageAttachments: ReadonlyMap<string, readonly ChatAttachment[]>;
}

export interface ChatAttachmentPreviewState {
	readonly attachment: ChatAttachment;
	readonly geometry: NonNullable<ReturnType<typeof previewGeometry>>;
	readonly placements: readonly ImagePlacement[];
}

export type ChatAttachmentMutation =
	| { readonly type: "accept_run_start"; readonly messageId: string }
	| { readonly type: "associate_message"; readonly messageId: string; readonly attachments: readonly ChatAttachment[] }
	| { readonly type: "reclaim"; readonly attachments: readonly ChatAttachment[] }
	| { readonly type: "restore_submission"; readonly attachments: readonly ChatAttachment[] }
	| { readonly type: "stage"; readonly attachment: ChatAttachment }
	| { readonly type: "take_submission"; readonly prompt: boolean };

interface AttachmentHitRegion {
	readonly targetKey: string;
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

export interface AttachmentInputPorts {
	readonly scrollBy: (delta: number) => void;
	readonly requestImmediateRender: () => void;
}

export interface ChatAttachmentControllerOptions {
	readonly theme: TuiTheme;
	readonly imagePreviewSupported: boolean;
	readonly initialAttachments?: readonly ChatAttachment[];
	readonly restoredAttachments?: ReadonlyMap<string, readonly ChatAttachment[]>;
	readonly onDetach?: (attachmentId: string) => Promise<void>;
	readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
	readonly invalidate: () => void;
	readonly reportError: (message: string) => void;
}

export class ChatAttachmentController {
	readonly #options: ChatAttachmentControllerOptions;
	#attachments: ChatAttachment[] = [];
	#attachmentFocusKey?: string;
	#attachmentFocusOrigin?: "keyboard" | "mouse";
	#attachmentHitRegions: AttachmentHitRegion[] = [];
	#imageModal = false;
	#nextRunAttachments?: readonly ChatAttachment[];
	readonly #messageAttachments = new Map<string, readonly ChatAttachment[]>();

	constructor(options: ChatAttachmentControllerOptions) {
		this.#options = options;
		this.#nextRunAttachments = options.initialAttachments;
		for (const [messageId, attachments] of options.restoredAttachments ?? []) {
			this.#messageAttachments.set(messageId, [...attachments]);
		}
	}

	view(projection: ChatAttachmentProjection): ChatAttachmentView {
		const focusedTarget = this.#focusedTarget(projection);
		return {
			staged: this.#attachments,
			focusKey: this.#attachmentFocusKey,
			imageModal: this.#imageModal,
			focusedTarget,
			focusedAttachment: focusedTarget?.attachment,
			messageAttachments: this.#messageAttachments,
		};
	}

	mutate(mutation: ChatAttachmentMutation): readonly ChatAttachment[] | undefined {
		switch (mutation.type) {
			case "stage":
				if (this.#attachments.some(({ id }) => id === mutation.attachment.id)) {
					throw new Error(`Attachment is already staged: ${mutation.attachment.id}`);
				}
				this.#attachments.push(mutation.attachment);
				this.#resetFocus();
				return undefined;
			case "take_submission": {
				const submitted = [...this.#attachments];
				if (mutation.prompt) this.#nextRunAttachments = submitted;
				this.#attachments = [];
				this.#resetFocus();
				return submitted;
			}
			case "restore_submission":
				if (this.#nextRunAttachments === mutation.attachments) this.#nextRunAttachments = undefined;
				this.#attachments = [...mutation.attachments, ...this.#attachments];
				return undefined;
			case "reclaim": {
				const known = new Set(this.#attachments.map(({ id }) => id));
				this.#attachments.push(...mutation.attachments.filter(({ id }) => !known.has(id)));
				this.#resetFocus();
				return undefined;
			}
			case "accept_run_start":
				if (this.#nextRunAttachments && this.#nextRunAttachments.length > 0) {
					this.#messageAttachments.set(mutation.messageId, this.#nextRunAttachments);
					this.#nextRunAttachments = undefined;
				}
				return undefined;
			case "associate_message":
				this.#messageAttachments.set(mutation.messageId, mutation.attachments);
				return undefined;
		}
	}

	layout(width: number): {
		readonly lines: readonly string[];
		readonly regions: readonly LocalAttachmentHitRegion[];
	} {
		if (this.#attachments.length === 0) return { lines: [], regions: [] };
		interface Token {
			readonly targetKey: string;
			readonly text: string;
			readonly width: number;
		}
		const rows: Token[][] = [[]];
		for (const [index, attachment] of this.#attachments.entries()) {
			const targetKey = attachmentTargetKey("composer", attachment.id, index);
			const focused = targetKey === this.#attachmentFocusKey;
			const label = `[${sanitizeTerminalText(attachment.filename).replace(/[\r\n]+/g, " ")}]`;
			const plain = clipAnsi(focused ? `›${label}` : label, width);
			const token: Token = {
				targetKey,
				text: focused ? this.#options.theme.style("accent", plain) : plain,
				width: displayWidth(plain),
			};
			let row = rows.at(-1)!;
			const used = row.reduce((total, entry) => total + entry.width, Math.max(0, row.length - 1));
			if (row.length > 0 && used + 1 + token.width > width) {
				row = [];
				rows.push(row);
			}
			row.push(token);
		}

		let hidden = rows.slice(2).reduce((total, row) => total + row.length, 0);
		const visible = rows.slice(0, 2);
		if (hidden > 0) {
			const last = visible[1] ?? [];
			if (!visible[1]) visible.push(last);
			while (last.length > 0) {
				const indicator = `… +${hidden}`;
				const used = last.reduce((total, entry) => total + entry.width, Math.max(0, last.length - 1));
				if (used + 1 + displayWidth(indicator) <= width) break;
				last.pop();
				hidden++;
			}
		}

		const regions: LocalAttachmentHitRegion[] = [];
		const lines = visible.map((row, rowIndex) => {
			let column = 0;
			const parts: string[] = [];
			for (const token of row) {
				if (parts.length > 0) column++;
				parts.push(token.text);
				regions.push({ targetKey: token.targetKey, row: rowIndex, start: column, end: column + token.width });
				column += token.width;
			}
			if (hidden > 0 && rowIndex === visible.length - 1) parts.push(clipAnsi(`… +${hidden}`, width));
			return clipAnsi(parts.join(" "), width);
		});
		return { lines, regions };
	}

	setHitRegions(regions: readonly AttachmentHitRegion[]): void {
		this.#attachmentHitRegions = [...regions];
	}

	handleInput(
		phase: "overlay" | "entry",
		input: TerminalInput,
		projection: ChatAttachmentProjection,
		ports: AttachmentInputPorts,
	): boolean {
		if (phase === "entry") {
			if (input.type !== "key" || input.action === "release" || input.key !== "tab") return false;
			const targets = this.#targets(projection);
			if (targets.length === 0) return false;
			this.#attachmentFocusKey = input.shift ? targets.at(-1)!.key : targets[0]!.key;
			this.#attachmentFocusOrigin = "keyboard";
			this.#requestNavigationRender(ports);
			return true;
		}
		if (input.type === "mouse") {
			this.#handleMouse(input, projection, ports);
			return true;
		}
		if (input.type !== "key" || input.action === "release") return false;
		if (this.#imageModal) {
			if (input.key === "escape" || input.key === "q") {
				this.#imageModal = false;
				this.#requestNavigationRender(ports);
			}
			return true;
		}
		const target = this.#focusedTarget(projection);
		if (!target) return false;
		if (input.key === "tab") {
			this.#moveFocus(input.shift ? -1 : 1, false, projection);
			this.#requestNavigationRender(ports);
			return true;
		}
		if (input.key === "left" || input.key === "right") {
			this.#moveFocus(input.key === "left" ? -1 : 1, true, projection);
			this.#requestNavigationRender(ports);
			return true;
		}
		if (input.key === "escape") {
			this.#resetFocus();
			this.#requestNavigationRender(ports);
			return true;
		}
		if (input.key === "delete" || input.key === "backspace") {
			if (target.source === "composer") void this.#detachFocused(projection);
			return true;
		}
		if (input.key === "enter") {
			if (this.#options.imagePreviewSupported && target.attachment.preview) {
				this.#imageModal = true;
				this.#requestNavigationRender(ports);
			} else if (this.#options.onOpenAttachment) {
				void this.#openFocusedAttachment(projection);
			}
			return true;
		}
		return true;
	}

	preview(
		context: RenderContext,
		dockRows: number,
		projection: ChatAttachmentProjection,
	): ChatAttachmentPreviewState | undefined {
		const attachment = this.#focusedTarget(projection)?.attachment;
		if (!attachment) return undefined;
		const geometry = previewGeometry(context.width, context.height, dockRows, attachment, this.#imageModal);
		if (!geometry) return undefined;
		const placements =
			this.#options.imagePreviewSupported && attachment.preview
				? [
						{
							stableKey: `attachment-preview:${attachment.id}`,
							generation: attachment.preview.generation,
							png: attachment.preview.png,
							row: geometry.imageRow,
							column: geometry.imageColumn,
							width: geometry.imageWidth,
							height: geometry.imageHeight,
						},
					]
				: [];
		return { attachment, geometry, placements };
	}

	#targets(projection: ChatAttachmentProjection): readonly AttachmentTarget[] {
		const targets: AttachmentTarget[] = this.#attachments.map((attachment, composerIndex) => ({
			key: attachmentTargetKey("composer", attachment.id, composerIndex),
			source: "composer",
			attachment,
			composerIndex,
		}));
		const addTimeline = (blockId: string, attachments: readonly ChatAttachment[]): void => {
			for (const [index, attachment] of attachments.entries()) {
				targets.push({
					key: attachmentTargetKey(blockId, attachment.id, index),
					source: "timeline",
					attachment,
				});
			}
		};
		for (const entry of projection.timelineEntries) {
			if (entry.kind !== "user") continue;
			const recovery =
				projection.recoverableCards.find((card) => card.messageId === entry.messageId) ??
				(projection.activeFollowUp?.messageId === entry.messageId ? projection.activeFollowUp : undefined);
			addTimeline(entry.id, this.#messageAttachments.get(entry.messageId) ?? recovery?.attachments ?? []);
		}
		for (const card of projection.provisionalCards) addTimeline(card.id, card.attachments);
		for (const card of projection.recoverableCards) {
			if (!card.messageId) addTimeline(`recoverable:${card.item.id}`, card.attachments);
		}
		return targets;
	}

	#focusedTarget(projection: ChatAttachmentProjection): AttachmentTarget | undefined {
		if (!this.#attachmentFocusKey) return undefined;
		return this.#targets(projection).find((target) => target.key === this.#attachmentFocusKey);
	}

	async #detachFocused(projection: ChatAttachmentProjection): Promise<void> {
		const target = this.#focusedTarget(projection);
		const index = target?.composerIndex;
		const attachment = target?.attachment;
		if (target?.source !== "composer" || index === undefined || !attachment) return;
		try {
			await this.#options.onDetach?.(attachment.id);
			this.#attachments.splice(index, 1);
			this.#imageModal = false;
			const nextIndex = Math.min(index, this.#attachments.length - 1);
			const next = this.#attachments[nextIndex];
			this.#attachmentFocusKey = next ? attachmentTargetKey("composer", next.id, nextIndex) : undefined;
			this.#attachmentFocusOrigin = this.#attachmentFocusKey === undefined ? undefined : "keyboard";
		} catch (error) {
			this.#options.reportError(error instanceof Error ? error.message : String(error));
		}
		this.#options.invalidate();
	}

	async #openFocusedAttachment(projection: ChatAttachmentProjection): Promise<void> {
		const attachment = this.#focusedTarget(projection)?.attachment;
		if (!attachment || !this.#options.onOpenAttachment) return;
		try {
			await this.#options.onOpenAttachment(attachment.id);
		} catch (error) {
			this.#options.reportError(error instanceof Error ? error.message : String(error));
			this.#options.invalidate();
		}
	}

	#moveFocus(delta: number, wrap: boolean, projection: ChatAttachmentProjection): void {
		const targets = this.#targets(projection);
		const current = targets.findIndex((target) => target.key === this.#attachmentFocusKey);
		if (current < 0 || targets.length === 0) return;
		const next = current + delta;
		if (!wrap && (next < 0 || next >= targets.length)) {
			this.#resetFocus();
			return;
		}
		this.#attachmentFocusKey = targets[(next + targets.length) % targets.length]!.key;
		this.#attachmentFocusOrigin = "keyboard";
	}

	#handleMouse(
		input: Extract<TerminalInput, { type: "mouse" }>,
		projection: ChatAttachmentProjection,
		ports: AttachmentInputPorts,
	): void {
		if (this.#imageModal) return;
		if (input.action === "press" && (input.button === "wheel-up" || input.button === "wheel-down")) {
			ports.scrollBy(input.button === "wheel-up" ? -3 : 3);
			this.#requestNavigationRender(ports);
			return;
		}
		const hit = this.#attachmentHitRegions.find(
			(region) => region.row === input.row && input.column >= region.start && input.column < region.end,
		);
		if (input.action === "move") {
			if (hit) {
				this.#attachmentFocusKey = hit.targetKey;
				this.#attachmentFocusOrigin = "mouse";
			} else if (this.#attachmentFocusOrigin === "mouse") {
				this.#resetFocus();
			}
			this.#requestNavigationRender(ports);
			return;
		}
		if (input.button !== "left" || !hit) return;
		this.#attachmentFocusKey = hit.targetKey;
		this.#attachmentFocusOrigin = "mouse";
		this.#requestNavigationRender(ports);
		if (input.action === "release" && !this.#options.imagePreviewSupported) {
			void this.#openFocusedAttachment(projection);
		}
	}

	#resetFocus(): void {
		this.#attachmentFocusKey = undefined;
		this.#attachmentFocusOrigin = undefined;
	}

	#requestNavigationRender(ports: AttachmentInputPorts): void {
		this.#options.invalidate();
		ports.requestImmediateRender();
	}
}
