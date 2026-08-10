import type { Editor } from "@coda/tui";
import { restoreExtensionReferences } from "./extension-references.ts";
import type { ComposerSubmission } from "./input-types.ts";

/** Owns Prompt-history entries, navigation position, and exact draft restoration. */
export class ComposerHistory {
	readonly #submissions: ComposerSubmission[] = [];
	readonly #retracted = new Set<string>();
	#index?: number;
	#draft?: ReturnType<Editor["captureState"]>;

	constructor(submissions: readonly ComposerSubmission[] = []) {
		for (const submission of submissions) this.#submissions.push(freezeSubmission(submission));
	}

	record(submission: ComposerSubmission): void {
		this.#submissions.push(freezeSubmission(submission));
		this.#resetNavigation();
	}

	retract(submissionId: string): void {
		this.#retracted.add(submissionId);
		this.#resetNavigation();
	}

	retractByQueueItemId(queueItemId: string): void {
		for (const submission of this.#submissions) {
			if (submission.queueItemId === queueItemId) this.#retracted.add(submission.id);
		}
		this.#resetNavigation();
	}

	/** Returns true when history consumed the key, false when Editor should handle it. */
	navigate(direction: -1 | 1, editor: Editor): boolean {
		if (editor.canMoveVertical(direction)) return false;
		const entries = this.#entries();
		if (entries.length === 0) return false;
		if (direction < 0) {
			if (this.#index === undefined) {
				this.#draft = editor.captureState();
				this.#index = entries.length - 1;
				showSubmission(editor, entries[this.#index]!);
				return true;
			}
			if (this.#index > 0) {
				this.#index--;
				showSubmission(editor, entries[this.#index]!);
			}
			return true;
		}

		if (this.#index === undefined) return false;
		if (this.#index < entries.length - 1) {
			this.#index++;
			showSubmission(editor, entries[this.#index]!);
			return true;
		}
		if (this.#draft) editor.restoreState(this.#draft);
		this.#resetNavigation();
		return true;
	}

	/** Editing a recalled value turns it into a new draft without mutating history. */
	noteTextMutation(): void {
		this.#resetNavigation();
	}

	reset(): void {
		this.#resetNavigation();
	}

	#entries(): readonly ComposerSubmission[] {
		const active = this.#submissions.filter((submission) => !this.#retracted.has(submission.id));
		const deduplicated: ComposerSubmission[] = [];
		for (const submission of active) {
			if (deduplicated.at(-1)?.text === submission.text) continue;
			deduplicated.push(submission);
		}
		return deduplicated;
	}

	#resetNavigation(): void {
		this.#index = undefined;
		this.#draft = undefined;
	}
}

function freezeSubmission(submission: ComposerSubmission): ComposerSubmission {
	if (submission.text.trim().length === 0) throw new Error("Composer history cannot record an empty submission");
	return Object.freeze({
		...submission,
		...(submission.references
			? { references: Object.freeze(submission.references.map((reference) => Object.freeze({ ...reference }))) }
			: {}),
	});
}

function showSubmission(editor: Editor, submission: ComposerSubmission): void {
	editor.setText(submission.text);
	restoreExtensionReferences(editor, submission.references);
}
