import type { Agent } from "@coda/agent";
import { type DiagnosticSink, type Keybinding, type Scheduler, type Terminal, Tui } from "@coda/tui";
import type { InteractiveApprovalHandler } from "./approval.ts";
import { ChatComponent } from "./chat-component.ts";

export interface InteractiveRunOptions {
	readonly agent: Agent;
	readonly terminal: Terminal;
	readonly clock: { now(): number };
	readonly scheduler: Scheduler;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly approval?: InteractiveApprovalHandler;
	readonly modelLabel: string;
	readonly reasoning: string;
	readonly initialPrompt?: string;
	readonly beforePrompt: (input: string) => Promise<void>;
}

export async function runInteractive(options: InteractiveRunOptions): Promise<number> {
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	let tui!: Tui;
	const submit = async (input: string): Promise<void> => {
		await options.beforePrompt(input);
		await options.agent.prompt(input);
	};
	const component = new ChatComponent({
		modelLabel: options.modelLabel,
		reasoning: options.reasoning,
		onSubmit: submit,
		onAbort: () => options.agent.abort(),
		onExit: resolveExit,
	});
	tui = new Tui({
		terminal: options.terminal,
		root: component,
		clock: options.clock,
		scheduler: options.scheduler,
		keybindings: options.keybindings,
		diagnostics: options.diagnostics,
	});
	options.approval?.bind(tui, options.terminal);
	const detach = options.agent.onEvent(async (event) => {
		component.accept(event);
		await tui.renderNow();
	});
	try {
		if (!(await tui.start())) throw new Error("Interactive mode requires a TTY terminal");
		if (options.initialPrompt?.trim()) await submit(options.initialPrompt.trim());
		await exited;
		return 0;
	} finally {
		options.approval?.unbind();
		detach();
		await tui.stop();
	}
}
