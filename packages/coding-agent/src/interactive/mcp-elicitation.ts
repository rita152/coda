import type { McpElicitationResult } from "@coda/mcp";
import type { McpAgentElicitation } from "@coda/runtime";
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

type ElicitationScalar = string | number | boolean;

const MAX_ELICITATION_QUEUE = 32;
const MAX_FORM_FIELD_CHARACTERS = 16_384;
const SECRET_SIGNAL = /password|passphrase|secret|token|credential|api[ _-]?key/iu;

interface FormField {
	readonly name: string;
	readonly label: string;
	readonly description?: string;
	readonly required: boolean;
	readonly type: "string" | "number" | "integer" | "boolean" | "array";
	readonly enumValues?: readonly ElicitationScalar[];
	value: string;
}

interface ElicitationComponentOptions {
	readonly request: McpAgentElicitation;
	readonly finish: (result: McpElicitationResult) => void;
}

function visible(value: string): string {
	let output = "";
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (character === "\n") output += character;
		else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e)) {
			output += `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
		} else output += character;
	}
	return sanitizeTerminalText(output);
}

function serverLabel(request: McpAgentElicitation): string {
	const implementation = request.server.server?.name;
	return implementation ? `${implementation} (${request.server.id})` : request.server.id;
}

function padded(value: string, width: number): string {
	const clipped = clipAnsi(value, width);
	return `${clipped}${" ".repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function framed(lines: readonly string[], width: number, height: number): string[] {
	if (width < 4 || height < 3) return lines.slice(0, Math.max(1, height)).map((line) => clipAnsi(line, width));
	const inner = width - 4;
	const body = lines.flatMap((line) => (line ? wrapAnsi(line, inner) : [""])).slice(0, height - 2);
	while (body.length < height - 2) body.push("");
	return [
		`╭${"─".repeat(width - 2)}╮`,
		...body.map((line) => `│ ${padded(line, inner)} │`),
		`╰${"─".repeat(width - 2)}╯`,
	];
}

function fieldType(schema: Record<string, unknown>): FormField["type"] | undefined {
	if (schema.type === "string" || schema.type === "number" || schema.type === "integer" || schema.type === "boolean") {
		return schema.type;
	}
	return schema.type === "array" ? "array" : undefined;
}

function initialValue(
	schema: Record<string, unknown>,
	type: FormField["type"],
	values?: readonly ElicitationScalar[],
): string {
	const value = schema.default ?? values?.[0];
	if (value !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
		return String(value);
	}
	return type === "boolean" ? "false" : "";
}

function formFields(request: McpAgentElicitation): readonly FormField[] {
	if (request.request.mode !== "form") return [];
	const schema = request.request.requestedSchema;
	const properties =
		typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
	);
	if (Object.keys(properties).length > 64) throw new Error("MCP Elicitation form exceeds the 64-field limit");
	return Object.entries(properties).map(([name, raw]) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`MCP Elicitation field "${name}" has an invalid Schema`);
		}
		const fieldSchema = raw as Record<string, unknown>;
		const type = fieldType(fieldSchema);
		if (!type) throw new Error(`MCP Elicitation field "${name}" uses an unsupported type`);
		const enumValues = Array.isArray(fieldSchema.enum)
			? fieldSchema.enum.filter(
					(value): value is ElicitationScalar =>
						typeof value === "string" || typeof value === "number" || typeof value === "boolean",
				)
			: undefined;
		return {
			name,
			label: typeof fieldSchema.title === "string" ? fieldSchema.title : name,
			...(typeof fieldSchema.description === "string" ? { description: fieldSchema.description } : {}),
			required: required.has(name),
			type,
			...(enumValues && enumValues.length > 0 ? { enumValues: Object.freeze(enumValues) } : {}),
			value: initialValue(fieldSchema, type, enumValues),
		};
	});
}

function asksForSecret(request: McpAgentElicitation): boolean {
	if (request.request.mode !== "form") return false;
	if (SECRET_SIGNAL.test(request.request.message)) return true;
	const properties = request.request.requestedSchema.properties;
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return false;
	return Object.entries(properties).some(([name, raw]) => {
		const schema =
			typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const signal = [name, schema.title, schema.description, schema.format]
			.filter((value): value is string => typeof value === "string")
			.join(" ");
		return SECRET_SIGNAL.test(signal) || schema.writeOnly === true;
	});
}

function parseField(field: FormField): ElicitationScalar | readonly string[] | undefined {
	if (field.required && field.value.trim().length === 0) throw new Error(`${field.label} is required`);
	if (!field.required && field.value.trim().length === 0) return undefined;
	if (field.enumValues && !field.enumValues.some((value) => String(value) === field.value)) {
		throw new Error(`${field.label} must use one of the offered values`);
	}
	switch (field.type) {
		case "string":
			return field.value;
		case "number": {
			const value = Number(field.value);
			if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number`);
			return value;
		}
		case "integer": {
			const value = Number(field.value);
			if (!Number.isInteger(value)) throw new Error(`${field.label} must be an integer`);
			return value;
		}
		case "boolean":
			return field.value === "true";
		case "array":
			return field.value
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
	}
}

class FormElicitationComponent extends Component {
	readonly #options: ElicitationComponentOptions;
	readonly #fields: readonly FormField[];
	#selected = 0;
	#error?: string;

	constructor(options: ElicitationComponentOptions) {
		super({ focusable: true });
		this.#options = options;
		this.#fields = formFields(options.request);
	}

	render({ width, height }: RenderContext): string[] {
		const request = this.#options.request.request;
		if (request.mode !== "form") return [];
		const fields = this.#fields.flatMap((field, index) => [
			`${index === this.#selected ? "›" : " "} ${visible(field.label)}${field.required ? " *" : ""}: ${visible(field.value || "(empty)")}`,
			...(field.description ? [`    ${visible(field.description)}`] : []),
		]);
		return framed(
			[
				`MCP Elicitation — ${visible(serverLabel(this.#options.request))}`,
				`Tool: ${visible(this.#options.request.tool.remoteName)}`,
				"",
				...request.message.split(/\r?\n/u).map(visible),
				"",
				"Do not enter passwords, tokens, API keys, or other secrets in an MCP form.",
				"",
				...fields,
				...(this.#error ? ["", `Error: ${visible(this.#error)}`] : []),
				"",
				"Up/Down selects • type to edit • Left/Right changes choices • Enter accepts",
				"Ctrl-D declines • Esc cancels",
			],
			width,
			height,
		);
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		if (input.type === "resize" || input.type === "mouse") return;
		if (input.type === "key" && input.action !== "release" && input.control && input.key === "d") {
			this.#options.finish({ action: "decline" });
			return;
		}
		if (input.type === "key" && input.action !== "release" && input.key === "escape") {
			this.#options.finish({ action: "cancel" });
			return;
		}
		const field = this.#fields[this.#selected];
		if (!field) {
			if (input.type === "key" && input.action !== "release" && input.key === "enter") {
				this.#options.finish({ action: "accept", content: {} });
			}
			return;
		}
		if (
			input.type === "key" &&
			input.action !== "release" &&
			(input.key === "up" || input.key === "down" || input.key === "tab")
		) {
			const delta = input.key === "up" || (input.key === "tab" && input.shift) ? -1 : 1;
			this.#selected = (this.#selected + delta + this.#fields.length) % this.#fields.length;
			this.#error = undefined;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.type === "key" && input.action !== "release" && input.key === "enter") {
			try {
				const content = Object.fromEntries(
					this.#fields.flatMap((candidate) => {
						const value = parseField(candidate);
						return value === undefined ? [] : [[candidate.name, value]];
					}),
				);
				this.#options.finish({ action: "accept", content });
			} catch (error) {
				this.#error = error instanceof Error ? error.message : String(error);
				this.invalidate();
				context.requestImmediateRender();
			}
			return;
		}
		if (field.enumValues || field.type === "boolean") {
			if (
				input.type === "key" &&
				input.action !== "release" &&
				(input.key === "left" || input.key === "right" || input.key === "space")
			) {
				const values = field.enumValues ?? [false, true];
				const current = Math.max(
					0,
					values.findIndex((value) => String(value) === field.value),
				);
				const delta = input.key === "left" ? -1 : 1;
				field.value = String(values[(current + delta + values.length) % values.length]);
				this.#error = undefined;
				this.invalidate();
				context.requestImmediateRender();
			}
			return;
		}
		if (input.type === "text" || input.type === "paste") {
			const appended = `${field.value}${input.text.replace(/[\r\n]/gu, " ")}`;
			field.value = appended.slice(0, MAX_FORM_FIELD_CHARACTERS);
			this.#error =
				appended.length > MAX_FORM_FIELD_CHARACTERS
					? `Field input is limited to ${MAX_FORM_FIELD_CHARACTERS} characters`
					: undefined;
			this.invalidate();
			return;
		}
		if (input.action !== "release" && input.key === "backspace") {
			field.value = Array.from(field.value).slice(0, -1).join("");
			this.#error = undefined;
			this.invalidate();
		}
	}
}

class UrlElicitationComponent extends Component {
	readonly #options: ElicitationComponentOptions;
	#selected = 0;

	constructor(options: ElicitationComponentOptions) {
		super({ focusable: true });
		this.#options = options;
	}

	render({ width, height }: RenderContext): string[] {
		const request = this.#options.request.request;
		if (request.mode !== "url") return [];
		let origin = "invalid URL";
		try {
			origin = new URL(request.url).origin;
		} catch {}
		const choices = ["I completed the external flow", "Decline"];
		return framed(
			[
				`MCP URL Elicitation — ${visible(serverLabel(this.#options.request))}`,
				`Tool: ${visible(this.#options.request.tool.remoteName)}`,
				"",
				...request.message.split(/\r?\n/u).map(visible),
				"",
				`Origin: ${visible(origin)}`,
				`URL: ${visible(request.url)}`,
				"",
				"Coda will not prefetch or open this URL. Review it, open it yourself if trusted, then return here.",
				"Never paste the resulting token or credential into Coda.",
				"",
				...choices.map((choice, index) => `${index === this.#selected ? "›" : " "} ${index + 1}. ${choice}`),
				"",
				"Up/Down selects • Enter confirms • Esc cancels",
			],
			width,
			height,
		);
	}

	handleInput(input: TerminalInput, context: ComponentInputContext): void {
		if (input.type !== "key" || input.action === "release") return;
		if (input.key === "escape") {
			this.#options.finish({ action: "cancel" });
			return;
		}
		if (input.key === "up" || input.key === "down") {
			this.#selected = (this.#selected + 1) % 2;
			this.invalidate();
			context.requestImmediateRender();
			return;
		}
		if (input.key === "enter") {
			this.#options.finish(this.#selected === 0 ? { action: "accept" } : { action: "decline" });
			return;
		}
		if (input.key === "1") this.#options.finish({ action: "accept" });
		if (input.key === "2") this.#options.finish({ action: "decline" });
	}
}

interface QueuedElicitation {
	readonly request: McpAgentElicitation;
	readonly sessionId?: string;
	readonly resolve: (result: McpElicitationResult) => void;
	readonly detachAbort: () => void;
}

interface PendingElicitation {
	readonly queued: QueuedElicitation;
	readonly handle: OverlayHandle;
}

export type McpElicitationWaitListener = (
	request: McpAgentElicitation,
	sessionId: string | undefined,
	waiting: boolean,
) => void;

export class InteractiveMcpElicitationHandler {
	#tui?: Tui;
	#terminal?: Terminal;
	#activeSessionId?: string;
	#pending?: PendingElicitation;
	#onWait?: McpElicitationWaitListener;
	readonly #queue: QueuedElicitation[] = [];

	bind(tui: Tui, terminal: Terminal, onWait?: McpElicitationWaitListener): void {
		if (this.#tui && this.#tui !== tui) throw new Error("MCP Elicitation handler is already bound to a TUI");
		this.#tui = tui;
		this.#terminal = terminal;
		this.#onWait = onWait;
	}

	forSession(sessionId: string): (request: McpAgentElicitation) => Promise<McpElicitationResult> {
		if (!sessionId) throw new Error("MCP Elicitation Session identity must not be empty");
		return (request) => this.#request(request, sessionId);
	}

	setActiveSession(sessionId: string): void {
		if (!sessionId) throw new Error("Active MCP Elicitation Session identity must not be empty");
		this.#activeSessionId = sessionId;
		if (this.#pending?.queued.sessionId && this.#pending.queued.sessionId !== sessionId) {
			const pending = this.#pending;
			this.#pending = undefined;
			pending.handle.remove();
			this.#queue.unshift(pending.queued);
		}
		this.#showNext();
	}

	request(request: McpAgentElicitation): Promise<McpElicitationResult> {
		return this.#request(request);
	}

	unbind(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.handle.remove();
		pending?.queued.detachAbort();
		if (pending) this.#notifyWait(pending.queued, false);
		pending?.queued.resolve({ action: "cancel" });
		for (const queued of this.#queue.splice(0)) {
			queued.detachAbort();
			this.#notifyWait(queued, false);
			queued.resolve({ action: "cancel" });
		}
		this.#tui = undefined;
		this.#terminal = undefined;
		this.#activeSessionId = undefined;
		this.#onWait = undefined;
	}

	#request(request: McpAgentElicitation, sessionId?: string): Promise<McpElicitationResult> {
		if (!this.#tui || !this.#terminal || !this.#tui.started) {
			return Promise.resolve({ action: "decline" });
		}
		if (asksForSecret(request)) return Promise.resolve({ action: "decline" });
		if (request.request.mode === "url") {
			try {
				const url = new URL(request.request.url);
				if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
					return Promise.resolve({ action: "decline" });
				}
			} catch {
				return Promise.resolve({ action: "decline" });
			}
		}
		if (this.#queue.length + (this.#pending ? 1 : 0) >= MAX_ELICITATION_QUEUE) {
			return Promise.resolve({ action: "decline" });
		}
		return new Promise<McpElicitationResult>((resolve) => {
			let queued!: QueuedElicitation;
			const onAbort = () => this.#cancel(queued);
			queued = {
				request,
				...(sessionId ? { sessionId } : {}),
				resolve,
				detachAbort: () => request.execution.signal.removeEventListener("abort", onAbort),
			};
			if (request.execution.signal.aborted) {
				resolve({ action: "cancel" });
				return;
			}
			request.execution.signal.addEventListener("abort", onAbort, { once: true });
			this.#queue.push(queued);
			this.#notifyWait(queued, true);
			this.#showNext();
		});
	}

	#showNext(): void {
		if (this.#pending || !this.#tui || !this.#terminal || !this.#tui.started) return;
		const index = this.#queue.findIndex(
			({ sessionId }) => sessionId === undefined || sessionId === this.#activeSessionId,
		);
		const next = index < 0 ? undefined : this.#queue.splice(index, 1)[0];
		if (!next) return;
		try {
			const finish = (result: McpElicitationResult) => this.#finish(result);
			const component =
				next.request.request.mode === "form"
					? new FormElicitationComponent({ request: next.request, finish })
					: new UrlElicitationComponent({ request: next.request, finish });
			const handle = this.#tui.showOverlay(component, {
				focus: true,
				layout: ({ columns, rows }) => elicitationPlacement(columns, rows),
			});
			this.#pending = { queued: next, handle };
		} catch {
			next.detachAbort();
			this.#notifyWait(next, false);
			next.resolve({ action: "decline" });
			this.#showNext();
		}
	}

	#finish(result: McpElicitationResult): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		pending.handle.remove();
		pending.queued.detachAbort();
		this.#notifyWait(pending.queued, false);
		pending.queued.resolve(result);
		this.#showNext();
	}

	#cancel(target: QueuedElicitation): void {
		if (this.#pending?.queued === target) {
			this.#finish({ action: "cancel" });
			return;
		}
		const index = this.#queue.indexOf(target);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		target.detachAbort();
		this.#notifyWait(target, false);
		target.resolve({ action: "cancel" });
	}

	#notifyWait(queued: QueuedElicitation, waiting: boolean): void {
		this.#onWait?.(queued.request, queued.sessionId, waiting);
	}
}

function elicitationPlacement(columns: number, rows: number): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(96, columns - 4);
	const height = Math.max(1, Math.min(rows < 14 ? rows : rows - 4, 24));
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}
