import type { PermissionProfile } from "@coda/sandbox";
import {
	Component,
	type ComponentInputContext,
	clipAnsi,
	displayWidth,
	type OverlayHandle,
	type OverlayPlacement,
	type RenderContext,
	sanitizeTerminalText,
	type TerminalInput,
	type Tui,
	wrapAnsi,
} from "@coda/tui";

interface Choice {
	readonly key: string;
	readonly value: string;
	readonly label: string;
	readonly description: string;
}

class PermissionOverlay extends Component {
	readonly #title: string;
	readonly #body: readonly string[];
	readonly #choices: readonly Choice[];
	readonly #finish: (value: string | undefined) => void;

	constructor(options: {
		readonly title: string;
		readonly body: readonly string[];
		readonly choices: readonly Choice[];
		readonly finish: (value: string | undefined) => void;
	}) {
		super({ focusable: true });
		this.#title = options.title;
		this.#body = options.body;
		this.#choices = options.choices;
		this.#finish = options.finish;
	}

	render({ width, height }: RenderContext): string[] {
		return renderPermissionOverlay(this.#title, this.#body, this.#choices, width, height);
	}

	handleInput(input: TerminalInput, _context: ComponentInputContext): void {
		if (input.type === "resize" || input.type === "mouse") return;
		const key =
			input.type === "key"
				? input.action === "release"
					? undefined
					: input.key
				: input.text.trim().toLowerCase()[0];
		if (!key) return;
		if (key === "escape" || key === "d") {
			this.#finish(undefined);
			return;
		}
		const choice = this.#choices.find((candidate) => candidate.key === key);
		if (choice) this.#finish(choice.value);
	}
}

export class InteractivePermissionSelector {
	readonly #tui: Tui;
	#pending?: OverlayHandle;

	constructor(tui: Tui) {
		this.#tui = tui;
	}

	async select(current: PermissionProfile): Promise<PermissionProfile | undefined> {
		for (;;) {
			const selected = await this.#show({
				title: "Select Permission Profile",
				body: [
					`Active: ${profileName(current)}`,
					"Changes apply to this process session and future Tool invocations.",
				],
				choices: [
					{
						key: "1",
						value: "read-only",
						label: "Read Only",
						description: "Full-disk reads; writes and network require approval.",
					},
					{
						key: "2",
						value: "workspace",
						label: "Workspace",
						description: "Write configured roots; protect metadata; network requires approval.",
					},
					{
						key: "3",
						value: "full-access",
						label: "Full Access",
						description: "No outer filesystem or network Sandbox; approvals default to Never.",
					},
				],
			});
			if (selected !== "read-only" && selected !== "workspace" && selected !== "full-access") return undefined;
			if (selected !== "full-access") return selected;

			const confirmed = await this.#show({
				title: "Enable Full Access for this session?",
				body: [
					"Model commands will run with your host-user filesystem and network authority.",
					"This significantly increases the risk of data loss, leaks, or unexpected behavior.",
					"Hard-deny Command Rules remain active, but the outer OS Sandbox is disabled.",
					"This process-only choice is not restored by a cold resume.",
				],
				choices: [
					{
						key: "1",
						value: "confirm",
						label: "Yes, continue anyway",
						description: "Apply Full Access for this session.",
					},
					{
						key: "2",
						value: "back",
						label: "Cancel",
						description: "Go back without enabling Full Access.",
					},
				],
			});
			if (confirmed === "confirm") return "full-access";
			if (confirmed !== "back") return undefined;
		}
	}

	async #show(options: {
		readonly title: string;
		readonly body: readonly string[];
		readonly choices: readonly Choice[];
	}): Promise<string | undefined> {
		if (!this.#tui.started) throw new Error("Permission selector requires an active TUI");
		if (this.#pending) throw new Error("Another Permission selector is already open");
		return new Promise<string | undefined>((resolve) => {
			const finish = (value: string | undefined) => {
				this.#pending?.remove();
				this.#pending = undefined;
				resolve(value);
			};
			const component = new PermissionOverlay({ ...options, finish });
			this.#pending = this.#tui.showOverlay(component, {
				focus: true,
				layout: ({ columns, rows }) => permissionPlacement(options, columns, rows),
			});
		});
	}
}

export function profileName(profile: PermissionProfile): string {
	return profile === "read-only" ? "Read Only" : profile === "workspace" ? "Workspace" : "Full Access";
}

function permissionPlacement(
	options: { readonly title: string; readonly body: readonly string[]; readonly choices: readonly Choice[] },
	columns: number,
	rows: number,
): OverlayPlacement {
	const width = columns < 64 ? columns : Math.min(88, columns - 4);
	const maxHeight = Math.max(1, rows < 12 ? rows : rows - 4);
	const height = renderPermissionOverlay(options.title, options.body, options.choices, width, maxHeight).length;
	return {
		row: Math.max(0, Math.floor((rows - height) / 2)),
		column: Math.max(0, Math.floor((columns - width) / 2)),
		width,
		height,
	};
}

function renderPermissionOverlay(
	title: string,
	body: readonly string[],
	choices: readonly Choice[],
	width: number,
	maxHeight: number,
): string[] {
	if (width < 4 || maxHeight < 3) return [clipAnsi(title, width)];
	const innerWidth = width - 4;
	const wrap = (value: string) => wrapAnsi(sanitizeTerminalText(value).replace(/[\r\n]+/gu, " "), innerWidth);
	const lines = [
		...wrap(title),
		"",
		...body.flatMap(wrap),
		"",
		...choices.flatMap((choice) => wrap(`[${choice.key}] ${choice.label} — ${choice.description}`)),
		...wrap("[d/Esc] Cancel"),
	].slice(0, Math.max(1, maxHeight - 2));
	const top = `╭${"─".repeat(width - 2)}╮`;
	const bottom = `╰${"─".repeat(width - 2)}╯`;
	return [
		top,
		...lines.map((line) => {
			const clipped = clipAnsi(line, innerWidth);
			return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - displayWidth(clipped)))} │`;
		}),
		bottom,
	];
}
