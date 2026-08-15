# `@coda/tui` Initial Design Spec

Status: implemented

Current package behavior is documented in
[`packages/tui/README.md`](../../packages/tui/README.md). The acceptance text
below describes the initial design frontier and is not a current status page.

## Objective

Provide a reusable Node.js terminal rendering and interaction layer for macOS and Linux without knowledge of Coda application policy.

## Package boundary

- The package is a Coda workspace leaf.
- It owns Terminal abstraction, ANSI rendering, layout, input routing, focus and overlay behavior, and generic components.
- It does not know about models, Providers, Agents, sessions, Credentials, Coda directories, or Coding Agent settings.
- Importing the package has no process-global side effects.
- Keybindings and the real Terminal implementation are explicitly injected.

## Input boundary

- `ProcessTerminal` parses terminal protocols and emits `KeyInput`, `TextInput`, `PasteInput`, or `ResizeInput`.
- Components never parse ANSI/CSI sequences or inspect process-global keyboard protocol state.
- Bracketed paste becomes one complete `PasteInput`.
- `VirtualTerminal` emits the same input union as the real Terminal.
- `KeyInput` contains a normalized logical key, optional insertable text, boolean shift/control/alt/meta modifiers, and `press | repeat | release` action.
- Caps Lock and Num Lock are not modifiers. Terminals without reliable release reporting emit only `press`.
- Logical names cover navigation, editing, whitespace, function keys, letters, digits, and canonical punctuation names. Unknown protocol sequences go to the Diagnostic sink, not Components.

## Terminal lifecycle

- `start()` and `stop()` are asynchronous and idempotent.
- A completed `start()` guarantees raw mode, paste handling, and keyboard negotiation are active.
- `stop()` drains input and restores listeners, protocols, raw mode, and cursor visibility in `finally` cleanup.
- Explicit `flush()` replaces fixed sleeps in shutdown and tests.
- Terminal dimensions are an immutable snapshot updated by `ResizeInput`.
- A completed start exposes immutable instance-local Terminal Capabilities for keyboard protocol, color level, synchronized output, and key-release support.
- Non-TTY use does not start a TUI. Legacy keyboards emit press-only events; unsupported synchronized output uses ordinary differential writes; `NO_COLOR` is respected.
- Unknown initial dimensions use `80×24` with a Diagnostic until resize supplies actual values.

## Renderer and component rules

- Interactive composition uses the alternate-screen `FullScreenTui`; terminal lifecycle and screen restoration remain hidden behind that Module.
- `Component.invalidate()` is required and schedules a coalesced render.
- Focus targets must be mounted and focusable.
- Overlays use stable handles for visibility, focus, and removal.
- Over-width output produces a renderer error; the package never chooses a log file.
- Debug and logging sinks are injected.
- Rendering uses injected Scheduler and Clock capabilities.
- Multiple invalidations coalesce into a frame capped at 60fps.
- Input may request an immediate post-callback frame without renderer reentrancy.
- `renderNow()` is reserved for startup, resize, deterministic tests, and controlled shutdown.
- `flush()` waits for scheduled rendering and Terminal output; it never sleeps for a guessed interval.

## First milestone

- `Terminal` and `ProcessTerminal`
- `Component.render(width): string[]`
- TUI lifecycle and differential rendering
- input routing
- focus and overlays
- explicit keybinding configuration
- a `VirtualTerminal` exported for deterministic tests
- ANSI display-width, clipping, and wrapping tests

## Deferred

- autocomplete
- Editor selection, redo, and durable draft storage
- general mouse handling
- OSC clipboard integration

Alternate-screen rendering, Timeline wheel navigation, limited image-label mouse input, Markdown, a grapheme-safe multiline Editor, and terminal image previews enter the visual-refresh milestone. General mouse handling, inline Timeline images, autocomplete, selection, and clipboard integration remain deferred.

## Initial accessibility scope

- Every first-release interaction is keyboard-operable and does not require a mouse.
- `NO_COLOR` and explicit `--no-color` are respected.
- `--no-tui` forces print mode; non-TTY use selects print automatically.
- Important state remains available through stable JSONL Agent events rather than only visual animation.
- A dedicated screen-reader renderer is deferred to a later TUI milestone.

## Design status

The first-milestone design frontier is closed. The implementation is available in `packages/tui` and preserves the
deferred boundary above.

Verification covers strict public-type consumption with Node streams, the root export surface, structured real and
virtual Terminal input, lifecycle cleanup, capability negotiation and fallback, ANSI cell geometry, differential
rendering, scheduling, non-reentrancy, keybindings, focus, overlays, Editor behavior, and cursor placement. Default tests do not require a real terminal.
