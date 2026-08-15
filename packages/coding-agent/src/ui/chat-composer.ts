import type { Editor } from "@coda/tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { ChatComponentOptions } from "./chat-component.ts";
import type { CommandFlowHost } from "./command-flow-host.ts";
import type { ComposerHistory } from "./composer-history.ts";

export function invokeChatCommand(input: {
	readonly command: CommandDefinition;
	readonly argument?: string;
	readonly editor: Editor;
	readonly history: ComposerHistory;
	readonly flow: CommandFlowHost;
	readonly onCommand: ChatComponentOptions["onCommand"];
	readonly setError: (value: string | undefined) => void;
	readonly setNotice: (value: string | undefined) => void;
	readonly invalidate: () => void;
}): void {
	input.editor.clear();
	input.history.reset();
	input.setError(undefined);
	input.setNotice(undefined);
	const operation = (() => {
		try {
			if (!input.onCommand) throw new Error(`${input.command.title} is unavailable`);
			return Promise.resolve(
				input.argument === undefined
					? input.onCommand(input.command.id, input.flow)
					: input.onCommand(input.command.id, input.flow, input.argument),
			);
		} catch (error) {
			return Promise.reject(error);
		}
	})();
	void operation.then(
		(notice) => {
			input.setNotice(notice || undefined);
			input.invalidate();
		},
		(error: unknown) => {
			input.setNotice(undefined);
			input.setError(error instanceof Error ? error.message : String(error));
			input.invalidate();
		},
	);
	input.invalidate();
}
