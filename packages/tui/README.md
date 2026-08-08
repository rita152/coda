# `@coda/tui`

Terminal abstraction, structured input, ANSI layout helpers, and main-screen differential rendering for Coda.

This package is intentionally application-neutral and has no dependency on another Coda workspace package.

## Milestone 1

- `Terminal`, `ProcessTerminal`, and the root-exported `VirtualTerminal`
- normalized key, text, paste, and resize input
- `Component` and a main-screen `Tui` with differential rendering
- explicit keybindings, focus, and stable overlay handles
- ANSI-aware display width, clipping, slicing, and hard wrapping
- injected clocks, schedulers, and diagnostics

Markdown, images, rich text, a full editor, autocomplete, alternate-screen rendering, mouse input, and clipboard
protocols are intentionally deferred.

## Composition

Runtime capabilities are explicit. Importing this package does not read or mutate process-global terminal state.

```ts
import {
	Component,
	createSystemClock,
	createSystemScheduler,
	ProcessTerminal,
	Tui,
} from "@coda/tui";

class Screen extends Component {
	render(width: number): string[] {
		return [`Terminal width: ${width}`];
	}
}

const terminal = new ProcessTerminal({
	input: process.stdin,
	output: process.stdout,
	environment: process.env,
	scheduler: createSystemScheduler(),
});

const tui = new Tui({
	terminal,
	root: new Screen(),
	clock: createSystemClock(),
	scheduler: createSystemScheduler(),
	keybindings: [],
});

if (await tui.start()) {
	try {
		await tui.flush();
	} finally {
		await tui.stop();
	}
}
```

`start()` returns `false` when the supplied streams cannot support an interactive TUI. Callers decide whether to
fall back to print mode.
