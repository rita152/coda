import type { AgentEvent } from "@coda/agent";
import { Component, type ComponentInputContext, type TerminalInput, wrapAnsi } from "@coda/tui";

export interface ChatComponentOptions {
	readonly modelLabel: string;
	readonly reasoning: string;
	readonly onSubmit: (input: string) => Promise<void>;
	readonly onAbort: () => void;
	readonly onExit: () => void;
}

function assistantText(event: Extract<AgentEvent, { type: "message_end" }>): string {
	return event.message.message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

export class ChatComponent extends Component {
	readonly #options: ChatComponentOptions;
	readonly #transcript: string[] = [];
	#input = "";
	#streaming = "";
	#running = false;
	#error?: string;

	constructor(options: ChatComponentOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	get running(): boolean {
		return this.#running;
	}

	accept(event: AgentEvent): void {
		switch (event.type) {
			case "run_start":
				this.#running = true;
				break;
			case "message_update":
				if (event.delta.type === "text_delta") this.#streaming += event.delta.delta;
				break;
			case "message_end": {
				const text = assistantText(event);
				if (text.length > 0) this.#transcript.push(`Coda: ${text}`);
				this.#streaming = "";
				break;
			}
			case "tool_execution_start":
				this.#transcript.push(`Tool ${event.invocation.toolName}: running`);
				break;
			case "tool_execution_end":
				this.#transcript.push(`Tool ${event.invocation.toolName}: ${event.outcome}`);
				break;
			case "tool_execution_rejected":
				this.#transcript.push(`Tool ${event.invocation.toolName}: rejected (${event.message})`);
				break;
			case "run_end":
				this.#running = false;
				if (event.outcome === "error") this.#error = event.failure?.message ?? "Run failed";
				if (event.outcome === "aborted") this.#transcript.push("Run aborted.");
				break;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const logical = [
			`Coda • ${this.#options.modelLabel} • reasoning ${this.#options.reasoning}`,
			"",
			...this.#transcript,
			...(this.#streaming ? [`Coda: ${this.#streaming}`] : []),
			...(this.#error ? [`Error: ${this.#error}`] : []),
			"",
			`${this.#running ? "…" : ">"} ${this.#input}`,
			this.#running ? "Ctrl-C aborts the Run" : "Enter sends • Ctrl-C exits",
		];
		return logical.flatMap((line) => (line.length === 0 ? [""] : wrapAnsi(line, width)));
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type === "resize") return;
		if (input.type === "text" || input.type === "paste") {
			if (!this.#running) {
				this.#input += input.text;
				this.invalidate();
			}
			return;
		}
		if (input.action === "release") return;
		if (input.control && input.key === "c") {
			if (this.#running) this.#options.onAbort();
			else this.#options.onExit();
			return;
		}
		if (input.text !== undefined && !this.#running) {
			this.#input += input.text;
			this.invalidate();
			return;
		}
		if (input.key === "escape" && !this.#running) {
			this.#options.onExit();
			return;
		}
		if (input.key === "backspace" && !this.#running) {
			const values = [...this.#input];
			values.pop();
			this.#input = values.join("");
			this.invalidate();
			return;
		}
		if (input.key !== "enter" || this.#running) return;
		const value = this.#input.trim();
		if (value.length === 0) return;
		this.#input = "";
		this.#error = undefined;
		this.#running = true;
		this.#transcript.push(`You: ${value}`);
		this.invalidate();
		void this.#options.onSubmit(value).catch((error: unknown) => {
			this.#running = false;
			this.#error = error instanceof Error ? error.message : String(error);
			this.invalidate();
		});
	}
}
