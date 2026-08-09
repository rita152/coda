# `@coda/tui`

Application-neutral terminal lifecycle, full-screen rendering, structured input, ANSI layout, Markdown, and terminal-image primitives for Coda.

The package is a workspace leaf. It does not know about Models, Agents, Sessions, Coding Agent policy, or process-global configuration.

## Current surface

- `Terminal`, `ProcessTerminal`, and deterministic `VirtualTerminal` adapters
- paired alternate-buffer, raw-input, bracketed-paste, cursor, autowrap, mouse, and synchronized-output lifecycle
- height-aware `Component` rendering with coalesced invalidation, focus, keybindings, and overlays
- ANSI-aware display width, clipping, slicing, wrapping, and untrusted terminal-text sanitization
- pure CommonMark/GFM terminal rendering with safe links and responsive code/table fallbacks
- a grapheme-safe multiline `Editor` with Pi-style borders, visual-row navigation, large-paste folding, and native/software cursor placement
- semantic `ImagePlacement` reconciliation through a Session-scoped Kitty image surface
- injected clocks, schedulers, capabilities, and diagnostics

`FullScreenTui` is the explicit application composition seam. `Tui` remains available for generic components and uses the same full-screen lifecycle; there is no regular inline renderer.

General mouse UI, clipboard protocols, autocomplete, selection, redo, durable drafts, syntax highlighting, Sixel, iTerm2 graphics, and multiplexer image passthrough remain outside this milestone. The structured mouse input surface supports application-owned wheel navigation and attachment hit regions.

## Composition

Runtime capabilities are explicit. Importing this package does not read or mutate process-global terminal state.

```ts
import {
  Component,
  createSystemClock,
  createSystemScheduler,
  FullScreenTui,
  ProcessTerminal,
  type RenderContext,
} from "@coda/tui";

class Screen extends Component {
  render({ width, height }: RenderContext): string[] {
    return [`Terminal size: ${width}x${height}`];
  }
}

const scheduler = createSystemScheduler();
const terminal = new ProcessTerminal({
  input: process.stdin,
  output: process.stdout,
  environment: process.env,
  scheduler,
});

const tui = new FullScreenTui({
  terminal,
  root: new Screen(),
  clock: createSystemClock(),
  scheduler,
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

`start()` returns `false` when the supplied streams cannot support an interactive TUI. Callers may recommend an explicit print mode, but should not silently start a different terminal UI.

`Terminal.flushOutput()` waits only for writes and is safe inside an input handler. `Terminal.flush()` additionally waits for queued input handlers and is intended for external settlement and tests.
