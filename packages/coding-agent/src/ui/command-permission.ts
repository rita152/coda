import type { CommandPermissionAskAnswer, CommandPermissionRequest } from "@coda/permission";
import {
	Component,
	type ComponentInputContext,
	type OverlayHandle,
	type OverlayPlacement,
	type RenderContext,
	type Terminal,
	type TerminalInput,
	type Tui,
	wrapAnsi,
} from "@coda/tui";

export type CommandPermissionAskRequest = CommandPermissionRequest & { readonly prompt: string };

class CommandPermissionComponent extends Component {
	readonly #prompt: string;
	readonly #finish: (result: CommandPermissionAskAnswer) => void;
	#index = 0;
	readonly #choices = [
		{ id: "allow", label: "Allow once" },
		{ id: "allow-session", label: "Allow for this Session" },
		{ id: "deny", label: "Deny" },
	] as const;

	constructor(prompt: string, finish: (result: CommandPermissionAskAnswer) => void) {
		super({ focusable: true });
		this.#prompt = prompt;
		this.#finish = finish;
	}

	render({ width }: RenderContext): string[] {
		const lines = [
			"Command Permission",
			"",
			...this.#prompt.split(/\r?\n/),
			"",
			...this.#choices.map((choice, index) => `${index === this.#index ? ">" : " "} ${choice.label}`),
			"",
			"Up/Down selects • Enter confirms • Esc denies",
		];
		return lines.flatMap((line) => (line ? wrapAnsi(line, width) : [""]));
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type !== "key" || input.action === "release") return;
		if ((input.control && input.key === "c") || input.key === "escape") {
			this.#finish({ action: "deny", reason: "User denied this Tool Invocation" });
			return;
		}
		if (input.key === "up") {
			this.#index = (this.#index - 1 + this.#choices.length) % this.#choices.length;
			this.invalidate();
			return;
		}
		if (input.key === "down") {
			this.#index = (this.#index + 1) % this.#choices.length;
			this.invalidate();
			return;
		}
		if (input.key === "enter") {
			const choice = this.#choices[this.#index];
			if (choice?.id === "deny") {
				this.#finish({ action: "deny", reason: "User denied this Tool Invocation" });
				return;
			}
			this.#finish({
				action: "allow",
				...(choice?.id === "allow-session" ? { remember: "session" as const } : {}),
			});
		}
	}
}

export class InteractiveCommandPermissionHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#pending?: { readonly resolve: (result: CommandPermissionAskAnswer) => void; readonly handle: OverlayHandle };

	bind(tui: Tui, terminal: Terminal): void {
		this.#tui = tui;
		this.#terminal = terminal;
	}

	unbind(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.handle.remove();
		pending?.resolve({ action: "deny", reason: "Command Permission prompt was dismissed" });
		this.#tui = undefined;
		this.#terminal = undefined;
	}

	request(request: CommandPermissionAskRequest): Promise<CommandPermissionAskAnswer> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.resolve({ action: "deny", reason: "Command Permission requires an interactive Session" });
		}
		if (this.#pending) {
			return Promise.resolve({ action: "deny", reason: "Another Command Permission prompt is already active" });
		}
		return new Promise((resolve) => {
			const finish = (result: CommandPermissionAskAnswer) => {
				const pending = this.#pending;
				this.#pending = undefined;
				pending?.handle.remove();
				resolve(result);
			};
			const handle = this.#tui!.showOverlay(new CommandPermissionComponent(request.prompt, finish), {
				focus: true,
				layout: ({ columns, rows }) => permissionPlacement(columns, rows),
			});
			this.#pending = { resolve: finish, handle };
		});
	}
}

function permissionPlacement(columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(88, columns - 4);
	const height = Math.min(18, Math.max(10, rows - 4));
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}
