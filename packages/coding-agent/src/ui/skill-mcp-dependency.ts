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
import type {
	SkillMcpDependencyDecision,
	SkillMcpDependencyDecisionRequest,
} from "../skills/mcp-dependency-coordinator.ts";

const MAX_DEPENDENCY_PROMPT_QUEUE = 32;

class SkillMcpDependencyComponent extends Component {
	readonly #request: SkillMcpDependencyDecisionRequest;
	readonly #finish: (decision: SkillMcpDependencyDecision) => void;
	#index = 0;

	constructor(request: SkillMcpDependencyDecisionRequest, finish: (decision: SkillMcpDependencyDecision) => void) {
		super({ focusable: true });
		this.#request = request;
		this.#finish = finish;
	}

	render({ width }: RenderContext): string[] {
		const lines = [
			this.#request.title,
			"",
			...this.#request.message.split(/\r?\n/u),
			"",
			...this.#request.choices.flatMap((choice, index) => [
				`${index === this.#index ? ">" : " "} ${choice.label}`,
				choice.description ? `  ${choice.description}` : "",
			]),
			"",
			"Up/Down selects • Enter confirms • Esc continues without installing",
		];
		return lines.flatMap((line) => (line ? wrapAnsi(line, width) : [""]));
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		if (input.type !== "key" || input.action === "release") return;
		if ((input.control && input.key === "c") || input.key === "escape") {
			this.#finish("continue");
			return;
		}
		if (input.key === "up" || input.key === "down") {
			const delta = input.key === "up" ? -1 : 1;
			this.#index = (this.#index + delta + this.#request.choices.length) % this.#request.choices.length;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "enter") {
			const selected = this.#request.choices[this.#index]?.id;
			this.#finish(selected === "install" ? "install" : "continue");
		}
	}
}

interface QueuedSkillMcpDependencyPrompt {
	readonly request: SkillMcpDependencyDecisionRequest;
	readonly sessionId: string;
	readonly resolve: (decision: SkillMcpDependencyDecision) => void;
	readonly detachAbort: () => void;
}

interface PendingSkillMcpDependencyPrompt {
	readonly queued: QueuedSkillMcpDependencyPrompt;
	readonly handle: OverlayHandle;
}

export type SkillMcpDependencyWaitListener = (
	request: SkillMcpDependencyDecisionRequest,
	sessionId: string,
	waiting: boolean,
) => void;

/** Presents Skill MCP dependency consent in the active interactive Session. */
export class InteractiveSkillMcpDependencyHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#activeSessionId?: string;
	#pending?: PendingSkillMcpDependencyPrompt;
	#onWait?: SkillMcpDependencyWaitListener;
	readonly #queue: QueuedSkillMcpDependencyPrompt[] = [];
	readonly #fallback?: (request: SkillMcpDependencyDecisionRequest) => Promise<SkillMcpDependencyDecision>;
	readonly #canUseFallback?: () => boolean;

	constructor(
		options: {
			readonly fallback?: (request: SkillMcpDependencyDecisionRequest) => Promise<SkillMcpDependencyDecision>;
			readonly canUseFallback?: () => boolean;
		} = {},
	) {
		this.#fallback = options.fallback;
		this.#canUseFallback = options.canUseFallback;
	}

	bind(tui: Tui, terminal: Terminal, onWait?: SkillMcpDependencyWaitListener): void {
		if (this.#tui && this.#tui !== tui) {
			throw new Error("Skill MCP dependency handler is already bound to a TUI");
		}
		this.#tui = tui;
		this.#terminal = terminal;
		this.#onWait = onWait;
	}

	forSession(sessionId: string): (request: SkillMcpDependencyDecisionRequest) => Promise<SkillMcpDependencyDecision> {
		if (!sessionId) throw new Error("Skill MCP dependency Session identity must not be empty");
		return (request) => this.#request(request, sessionId);
	}

	setActiveSession(sessionId: string): void {
		if (!sessionId) throw new Error("Active Skill MCP dependency Session identity must not be empty");
		this.#activeSessionId = sessionId;
		if (this.#pending && this.#pending.queued.sessionId !== sessionId) {
			const pending = this.#pending;
			this.#pending = undefined;
			pending.handle.remove();
			this.#queue.unshift(pending.queued);
		}
		this.#showNext();
	}

	unbind(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.handle.remove();
		pending?.queued.detachAbort();
		if (pending) this.#notifyWait(pending.queued, false);
		pending?.queued.resolve("continue");
		for (const queued of this.#queue.splice(0)) {
			queued.detachAbort();
			this.#notifyWait(queued, false);
			queued.resolve("continue");
		}
		this.#tui = undefined;
		this.#terminal = undefined;
		this.#activeSessionId = undefined;
		this.#onWait = undefined;
	}

	#request(request: SkillMcpDependencyDecisionRequest, sessionId: string): Promise<SkillMcpDependencyDecision> {
		if (request.signal.aborted) return Promise.reject(request.signal.reason);
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return this.#fallback && (this.#canUseFallback?.() ?? true)
				? this.#fallback(request)
				: Promise.resolve("continue");
		}
		if (this.#queue.length + (this.#pending ? 1 : 0) >= MAX_DEPENDENCY_PROMPT_QUEUE) {
			return Promise.resolve("continue");
		}
		return new Promise((resolve) => {
			let queued!: QueuedSkillMcpDependencyPrompt;
			const onAbort = () => this.#cancel(queued);
			queued = {
				request,
				sessionId,
				resolve,
				detachAbort: () => request.signal.removeEventListener("abort", onAbort),
			};
			request.signal.addEventListener("abort", onAbort, { once: true });
			this.#queue.push(queued);
			this.#notifyWait(queued, true);
			this.#showNext();
		});
	}

	#showNext(): void {
		if (this.#pending || !this.#tui || !this.#terminal || !this.#tui.started) return;
		const index = this.#queue.findIndex(({ sessionId }) => sessionId === this.#activeSessionId);
		const next = index < 0 ? undefined : this.#queue.splice(index, 1)[0];
		if (!next) return;
		const finish = (decision: SkillMcpDependencyDecision) => this.#finish(decision);
		const handle = this.#tui.showOverlay(new SkillMcpDependencyComponent(next.request, finish), {
			focus: true,
			layout: ({ columns, rows }) => skillMcpDependencyPlacement(columns, rows),
		});
		this.#pending = { queued: next, handle };
	}

	#finish(decision: SkillMcpDependencyDecision): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		pending.handle.remove();
		pending.queued.detachAbort();
		this.#notifyWait(pending.queued, false);
		pending.queued.resolve(decision);
		this.#showNext();
	}

	#cancel(target: QueuedSkillMcpDependencyPrompt): void {
		if (this.#pending?.queued === target) {
			this.#finish("continue");
			return;
		}
		const index = this.#queue.indexOf(target);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		target.detachAbort();
		this.#notifyWait(target, false);
		target.resolve("continue");
	}

	#notifyWait(queued: QueuedSkillMcpDependencyPrompt, waiting: boolean): void {
		this.#onWait?.(queued.request, queued.sessionId, waiting);
	}
}

function skillMcpDependencyPlacement(columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(96, columns - 4);
	const height = Math.max(1, Math.min(rows < 14 ? rows : rows - 4, 22));
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}
