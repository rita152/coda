import type { Editor, EditorMarker, ImagePlacement, RenderContext, TerminalInput } from "@coda/tui";
import { attachmentElementLabel } from "./attachment-label.ts";
import type { ChatAttachment } from "./chat-component.ts";
import { attachmentTargetKey, previewGeometry } from "./chat-rendering.ts";
import type { TimelineProvisionalCard, TimelineRecoverableCard } from "./chat-timeline-renderer.ts";
import type { TimelineEntry } from "./semantic-timeline.ts";

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
	readonly focusOrigin?: "keyboard" | "mouse";
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
	| { readonly type: "stage"; readonly attachment: ChatAttachment; readonly at?: number }
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
	readonly editor: Editor;
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
	readonly #editor: Editor;
	#attachments: ChatAttachment[] = [];
	readonly #attachmentUndoStash = new Map<string, ChatAttachment>();
	#inlineElementsSuspended = false;
	#attachmentFocusKey?: string;
	#attachmentFocusOrigin?: "keyboard" | "mouse";
	#attachmentHitRegions: AttachmentHitRegion[] = [];
	#imageModal = false;
	#nextRunAttachments?: readonly ChatAttachment[];
	readonly #messageAttachments = new Map<string, readonly ChatAttachment[]>();

	constructor(options: ChatAttachmentControllerOptions) {
		this.#options = options;
		this.#editor = options.editor;
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
			focusOrigin: this.#attachmentFocusOrigin,
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
				this.#attachmentUndoStash.delete(mutation.attachment.id);
				this.#attachments.push(mutation.attachment);
				if (!this.#inlineElementsSuspended) insertAttachmentElement(this.#editor, mutation.attachment, mutation.at);
				this.#sortComposerAttachments();
				this.#resetFocus();
				return undefined;
			case "take_submission": {
				this.reconcileEditor();
				const submitted = [...this.#attachments];
				if (mutation.prompt) this.#nextRunAttachments = submitted;
				this.#attachments = [];
				this.#discardUndoStash();
				this.#resetFocus();
				return submitted;
			}
			case "restore_submission":
				if (this.#nextRunAttachments === mutation.attachments) this.#nextRunAttachments = undefined;
				this.#attachments = [...mutation.attachments, ...this.#attachments];
				if (this.#editor.text.length > 0) {
					for (const attachment of mutation.attachments) this.#restoreAttachmentElement(attachment);
					this.#sortComposerAttachments();
				}
				return undefined;
			case "reclaim": {
				const known = new Set(this.#attachments.map(({ id }) => id));
				const reclaimed = mutation.attachments.filter(({ id }) => !known.has(id));
				this.#attachments.push(...reclaimed);
				for (const attachment of reclaimed) this.#restoreAttachmentElement(attachment);
				this.#sortComposerAttachments();
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

	/** Reconciles atomic inline elements after an Editor mutation, retaining removals for undo. */
	reconcileEditor(): void {
		if (this.#inlineElementsSuspended) return;
		const liveIds = new Set(
			this.#editor.markers.flatMap((marker) => {
				const attachmentId = attachmentIdFromMarkerValue(marker.value);
				return attachmentId ? [attachmentId] : [];
			}),
		);
		const retained: ChatAttachment[] = [];
		for (const attachment of this.#attachments) {
			if (liveIds.has(attachment.id)) retained.push(attachment);
			else this.#attachmentUndoStash.set(attachment.id, attachment);
		}
		for (const attachmentId of liveIds) {
			if (retained.some(({ id }) => id === attachmentId)) continue;
			const restored = this.#attachmentUndoStash.get(attachmentId);
			if (!restored) continue;
			this.#attachmentUndoStash.delete(attachmentId);
			retained.push(restored);
		}
		this.#attachments = retained;
		this.#sortComposerAttachments();
		if (this.#attachmentFocusKey && !this.#focusedTarget(this.#emptyProjection())) this.#resetFocus();
		while (this.#attachmentUndoStash.size > 20) {
			const discarded = this.#attachmentUndoStash.values().next().value as ChatAttachment | undefined;
			if (!discarded) break;
			this.#attachmentUndoStash.delete(discarded.id);
			this.#discardAttachment(discarded);
		}
	}

	hasOnlyInlineElements(): boolean {
		if (this.#attachments.length === 0 || this.#inlineElementsSuspended) return false;
		let text = this.#editor.text;
		const ranges = this.#editor.markers
			.filter((marker) => attachmentIdFromMarkerValue(marker.value) !== undefined)
			.sort((left, right) => right.start - left.start);
		for (const range of ranges) text = `${text.slice(0, range.start)}${text.slice(range.end)}`;
		return text.trim().length === 0;
	}

	suspendInlineElements(): void {
		if (this.#inlineElementsSuspended) return;
		let text = this.#editor.text;
		const ranges = this.#editor.markers
			.filter((marker) => attachmentIdFromMarkerValue(marker.value) !== undefined)
			.sort((left, right) => right.start - left.start);
		for (const range of ranges) text = `${text.slice(0, range.start)}${text.slice(range.end)}`;
		this.#inlineElementsSuspended = true;
		this.#editor.setText(text.trim().length === 0 ? "" : text);
	}

	restoreInlineElements(): void {
		if (!this.#inlineElementsSuspended) return;
		this.#inlineElementsSuspended = false;
		for (const attachment of this.#attachments) insertAttachmentElement(this.#editor, attachment);
		this.#sortComposerAttachments();
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
		if (this.#attachmentFocusOrigin === "mouse") {
			this.#resetFocus();
			this.#requestNavigationRender(ports);
			return false;
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
		if (!this.#imageModal) return undefined;
		const attachment = this.#focusedTarget(projection)?.attachment;
		if (!attachment) return undefined;
		const geometry = previewGeometry(context.width, context.height, dockRows, attachment, true);
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
			removeAttachmentElement(this.#editor, attachment.id);
			this.#attachments.splice(index, 1);
			this.#attachmentUndoStash.delete(attachment.id);
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
		if (input.action === "release") {
			const attachment = this.#focusedTarget(projection)?.attachment;
			if (this.#options.imagePreviewSupported && attachment?.preview) this.#imageModal = true;
			else void this.#openFocusedAttachment(projection);
		}
		this.#requestNavigationRender(ports);
	}

	#resetFocus(): void {
		this.#attachmentFocusKey = undefined;
		this.#attachmentFocusOrigin = undefined;
	}

	#restoreAttachmentElement(attachment: ChatAttachment): void {
		if (this.#editor.markers.some((marker) => attachmentIdFromMarkerValue(marker.value) === attachment.id)) return;
		const label = attachmentElementLabel(attachment.filename);
		const occupied = this.#editor.markers
			.filter((marker) => attachmentIdFromMarkerValue(marker.value) !== undefined)
			.map(({ start, end }) => ({ start, end }));
		let start = this.#editor.text.indexOf(label);
		while (start >= 0) {
			const end = start + label.length;
			if (!occupied.some((range) => start < range.end && end > range.start)) {
				this.#editor.addMarker(attachmentEditorMarker(attachment.id, start, end));
				return;
			}
			start = this.#editor.text.indexOf(label, start + label.length);
		}
		insertAttachmentElement(this.#editor, attachment);
	}

	#sortComposerAttachments(): void {
		const starts = new Map<string, number>();
		for (const marker of this.#editor.markers) {
			const attachmentId = attachmentIdFromMarkerValue(marker.value);
			if (attachmentId) starts.set(attachmentId, marker.start);
		}
		this.#attachments.sort(
			(left, right) =>
				(starts.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (starts.get(right.id) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	#discardUndoStash(): void {
		for (const attachment of this.#attachmentUndoStash.values()) this.#discardAttachment(attachment);
		this.#attachmentUndoStash.clear();
	}

	#discardAttachment(attachment: ChatAttachment): void {
		void Promise.resolve(this.#options.onDetach?.(attachment.id)).catch((error: unknown) => {
			this.#options.reportError(error instanceof Error ? error.message : String(error));
			this.#options.invalidate();
		});
	}

	#emptyProjection(): ChatAttachmentProjection {
		return { timelineEntries: [], provisionalCards: [], recoverableCards: [] };
	}

	#requestNavigationRender(ports: AttachmentInputPorts): void {
		this.#options.invalidate();
		ports.requestImmediateRender();
	}
}

const ATTACHMENT_MARKER_KIND = "chat-attachment";

interface AttachmentMarkerValue {
	readonly kind: typeof ATTACHMENT_MARKER_KIND;
	readonly attachmentId: string;
}

export function attachmentIdFromMarkerValue(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<AttachmentMarkerValue>;
	return candidate.kind === ATTACHMENT_MARKER_KIND && typeof candidate.attachmentId === "string"
		? candidate.attachmentId
		: undefined;
}

/** Converts visual `[filename]` elements to submitted `filename` text and keeps other marker offsets aligned. */
export function normalizeAttachmentElements(
	text: string,
	markers: readonly EditorMarker[],
): { readonly text: string; readonly markers: readonly EditorMarker[] } {
	let normalizedText = text;
	let normalizedMarkers = [...markers];
	const attachmentMarkers = markers
		.filter((marker) => attachmentIdFromMarkerValue(marker.value) !== undefined)
		.sort((left, right) => right.start - left.start);
	for (const attachmentMarker of attachmentMarkers) {
		const display = normalizedText.slice(attachmentMarker.start, attachmentMarker.end);
		const replacement = display.startsWith("[") && display.endsWith("]") ? display.slice(1, -1) : display;
		const delta = replacement.length - (attachmentMarker.end - attachmentMarker.start);
		normalizedText = `${normalizedText.slice(0, attachmentMarker.start)}${replacement}${normalizedText.slice(attachmentMarker.end)}`;
		normalizedMarkers = normalizedMarkers.flatMap((marker) => {
			if (marker.id === attachmentMarker.id) return [];
			if (marker.end <= attachmentMarker.start) return [marker];
			if (marker.start >= attachmentMarker.end) {
				return [Object.freeze({ ...marker, start: marker.start + delta, end: marker.end + delta })];
			}
			return [];
		});
	}
	return Object.freeze({ text: normalizedText, markers: Object.freeze(normalizedMarkers) });
}

function insertAttachmentElement(editor: Editor, attachment: ChatAttachment, requestedOffset?: number): void {
	const offset = Math.max(0, Math.min(requestedOffset ?? editor.cursorOffset, editor.text.length));
	const label = attachmentElementLabel(attachment.filename);
	const leading = offset > 0 && !/\s$/u.test(editor.text.slice(0, offset)) ? " " : "";
	const trailing = offset < editor.text.length && /^\s/u.test(editor.text.slice(offset)) ? "" : " ";
	const value = `${leading}${label}${trailing}`;
	const start = offset + leading.length;
	const end = start + label.length;
	editor.replaceRange(offset, offset, value);
	editor.addMarker(attachmentEditorMarker(attachment.id, start, end));
}

function attachmentEditorMarker(attachmentId: string, start: number, end: number): EditorMarker<AttachmentMarkerValue> {
	return Object.freeze({
		id: `chat-attachment:${attachmentId}`,
		start,
		end,
		value: Object.freeze({ kind: ATTACHMENT_MARKER_KIND, attachmentId }),
		atomic: true,
	});
}

function removeAttachmentElement(editor: Editor, attachmentId: string): void {
	const marker = editor.markers.find((candidate) => attachmentIdFromMarkerValue(candidate.value) === attachmentId);
	if (!marker) return;
	let start = marker.start;
	let end = marker.end;
	if (/^\s/u.test(editor.text.slice(end))) end++;
	else if (/\s$/u.test(editor.text.slice(0, start))) start--;
	editor.replaceRange(start, end, "");
}
