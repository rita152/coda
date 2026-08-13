# Add viewport, input, and responsive overlays

Type: task
Status: resolved
Blocked by: 01

Build the fixed header/transcript/dock layout, logical scroll anchors, unread state, transcript-mode navigation, too-small view, responsive input modal, Timeline wheel navigation, and limited image-label mouse input.

## Acceptance

- Tail-follow, manual scroll, resize anchoring, and Ctrl+End behavior match the spec.
- Header/footer degrade by priority and the `40x10` fallback remains operable.
- Modal focus prevents global scroll bindings from stealing input.
- Keyboard paths cover every interaction; mouse input is limited to Timeline wheel navigation and image labels.

## Comments

## Answer

Implemented semantic scroll anchors, tail-follow and unread state, responsive header/dock/modal behavior, too-small fallback, Transcript View navigation, physical-row mouse-wheel scrolling, and keyboard-complete attachment-label mouse enhancement. A real PTY regression test verifies wheel-up and wheel-down viewport movement.
