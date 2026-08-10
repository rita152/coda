import {
	Component,
	type ComponentInputContext,
	type ComponentInputResult,
	type CursorPlacement,
	type ImagePlacement,
	observeInvalidation,
	type RenderContext,
	setComponentFocused,
	type TerminalInput,
} from "@coda/tui";

/** A stable TUI root whose foreground child can change without unmounting the TUI. */
export class SwitchableComponent extends Component {
	#selected: Component;
	#detachInvalidation: () => void;

	constructor(initial: Component) {
		super({ focusable: true });
		this.#selected = initial;
		this.#detachInvalidation = this.#observe(initial);
	}

	get selected(): Component {
		return this.#selected;
	}

	select(component: Component): void {
		if (component === this.#selected) return;
		setComponentFocused(this.#selected, false);
		this.#detachInvalidation();
		this.#selected = component;
		setComponentFocused(component, this.focused);
		this.#detachInvalidation = this.#observe(component);
		this.invalidate();
	}

	render(context: RenderContext): string[] {
		this.#synchronizeFocus();
		return this.#selected.render(context);
	}

	override animationInterval(context: RenderContext): number | undefined {
		return this.#selected.animationInterval(context);
	}

	override imagePlacements(context: RenderContext): readonly ImagePlacement[] {
		return this.#selected.imagePlacements(context);
	}

	override cursorPlacement(context: RenderContext): CursorPlacement | undefined {
		this.#synchronizeFocus();
		return this.#selected.cursorPlacement(context);
	}

	override handleInput(input: TerminalInput, context: ComponentInputContext): ComponentInputResult {
		this.#synchronizeFocus();
		return this.#selected.handleInput?.(input, context);
	}

	dispose(): void {
		this.#detachInvalidation();
		setComponentFocused(this.#selected, false);
	}

	#observe(component: Component): () => void {
		return observeInvalidation(component, () => this.invalidate());
	}

	#synchronizeFocus(): void {
		setComponentFocused(this.#selected, this.focused);
	}
}
