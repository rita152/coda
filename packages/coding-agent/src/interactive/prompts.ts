import {
	Component,
	type ComponentInputContext,
	type DiagnosticSink,
	type Keybinding,
	type RenderContext,
	type Scheduler,
	type Terminal,
	type TerminalInput,
	Tui,
	wrapAnsi,
} from "@coda/tui";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./process-lifecycle.ts";

export interface PromptRuntime {
	readonly terminal: Terminal;
	readonly clock: { now(): number };
	readonly scheduler: Scheduler;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly lifecycle?: InteractiveProcessLifecycle;
}

export interface PromptChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

class ChoiceComponent extends Component {
	readonly #title: string;
	readonly #choices: readonly PromptChoice[];
	readonly #finish: (selection: string | undefined) => void;
	#index = 0;

	constructor(title: string, choices: readonly PromptChoice[], finish: (selection: string | undefined) => void) {
		super({ focusable: true });
		this.#title = title;
		this.#choices = choices;
		this.#finish = finish;
	}

	render({ width }: RenderContext): string[] {
		const lines = [
			...this.#title.split(/\r?\n/),
			"",
			...this.#choices.flatMap((choice, index) => [
				`${index === this.#index ? ">" : " "} ${choice.label}`,
				...(choice.description ? [`  ${choice.description}`] : []),
			]),
			"",
			"Up/Down selects • Enter confirms • Esc cancels",
		];
		return lines.flatMap((line) => (line ? wrapAnsi(line, width) : [""]));
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type !== "key" || input.action === "release") return;
		if ((input.control && input.key === "c") || input.key === "escape") {
			this.#finish(undefined);
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
		if (input.key === "enter") this.#finish(this.#choices[this.#index]?.id);
	}
}

class TextPromptComponent extends Component {
	readonly #message: string;
	readonly #placeholder?: string;
	readonly #secret: boolean;
	readonly #finish: (value: string | undefined) => void;
	#value = "";

	constructor(
		message: string,
		placeholder: string | undefined,
		secret: boolean,
		finish: (value: string | undefined) => void,
	) {
		super({ focusable: true });
		this.#message = message;
		this.#placeholder = placeholder;
		this.#secret = secret;
		this.#finish = finish;
	}

	render({ width }: RenderContext): string[] {
		const visible = this.#secret ? "•".repeat([...this.#value].length) : this.#value;
		const input = visible || (this.#placeholder ? `(${this.#placeholder})` : "");
		return [this.#message, "", `> ${input}`, "", "Enter confirms • Esc cancels"].flatMap((line) =>
			line ? wrapAnsi(line, width) : [""],
		);
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type === "resize" || input.type === "mouse") return;
		if (input.type === "text" || input.type === "paste") {
			this.#value += input.text;
			this.invalidate();
			return;
		}
		if (input.action === "release") return;
		if ((input.control && input.key === "c") || input.key === "escape") {
			this.#finish(undefined);
			return;
		}
		if (input.key === "backspace") {
			const characters = [...this.#value];
			characters.pop();
			this.#value = characters.join("");
			this.invalidate();
			return;
		}
		if (input.key === "enter") this.#finish(this.#value);
	}
}

async function runPrompt(
	runtime: PromptRuntime,
	create: (finish: (value: string | undefined) => void) => Component,
): Promise<string | undefined> {
	let resolveResult!: (value: string | undefined) => void;
	const result = new Promise<string | undefined>((resolve) => {
		resolveResult = resolve;
	});
	let settled = false;
	const finish = (value: string | undefined): void => {
		if (settled) return;
		settled = true;
		resolveResult(value);
	};
	const tui = new Tui({
		terminal: runtime.terminal,
		root: create(finish),
		clock: runtime.clock,
		scheduler: runtime.scheduler,
		keybindings: runtime.keybindings,
		diagnostics: runtime.diagnostics,
	});
	let termination: InteractiveTerminationError | undefined;
	let fatalFailure: { readonly error: unknown } | undefined;
	let suspendTask: Promise<void> | undefined;
	const unsubscribeLifecycle = runtime.lifecycle?.subscribe({
		terminate: (signal) => {
			termination ??= new InteractiveTerminationError(signal);
			finish(undefined);
		},
		fatal: (error) => {
			fatalFailure ??= { error };
			finish(undefined);
		},
		suspend: () => {
			if (suspendTask) return;
			suspendTask = (async () => {
				if (tui.started) await tui.stop();
				await runtime.lifecycle!.suspend();
				if (!(await tui.start())) throw new Error("Terminal was unavailable after process resume");
			})().catch((error: unknown) => {
				fatalFailure ??= { error };
				finish(undefined);
			});
			void suspendTask.finally(() => {
				suspendTask = undefined;
			});
		},
	});
	try {
		if (!(await tui.start())) {
			throw new Error("Interactive full-screen mode is unavailable; use --no-tui for print mode");
		}
		const value = await result;
		if (suspendTask) await suspendTask;
		if (termination) throw termination;
		if (fatalFailure) throw fatalFailure.error;
		return value;
	} finally {
		unsubscribeLifecycle?.();
		finish(undefined);
		if (suspendTask) await suspendTask;
		await tui.stop();
	}
}

export async function selectFromTerminal(
	runtime: PromptRuntime,
	title: string,
	choices: readonly PromptChoice[],
): Promise<string | undefined> {
	if (choices.length === 0) throw new Error("Interactive selection requires at least one choice");
	return runPrompt(runtime, (finish) => new ChoiceComponent(title, choices, finish));
}

export function promptTextFromTerminal(
	runtime: PromptRuntime,
	options: { readonly message: string; readonly placeholder?: string; readonly secret?: boolean },
): Promise<string | undefined> {
	return runPrompt(
		runtime,
		(finish) => new TextPromptComponent(options.message, options.placeholder, options.secret ?? false, finish),
	);
}

export async function confirmFromTerminal(runtime: PromptRuntime, message: string): Promise<boolean> {
	return (
		(await selectFromTerminal(runtime, message, [
			{ id: "no", label: "No — stop without trusting it" },
			{ id: "yes", label: "Yes — trust this exact Workspace and SHA-256" },
		])) === "yes"
	);
}
