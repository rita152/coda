# Add terminal appearance and semantic surface Theme

Type: task
Status: resolved

Add the `auto | light | dark` configuration path, bounded OSC 11 negotiation, immutable appearance capability, semantic surface Theme tokens, and accessible color-level fallbacks.

## Acceptance

- Explicit schemes bypass background querying and CLI overrides settings.
- Auto detection settles within the existing 100 ms startup window.
- Malformed, timed-out, and late responses cannot change settled appearance.
- Light, dark, unknown, 256/16-color, and NO_COLOR rendering are deterministic and readable.

## Answer

Added immutable terminal appearance capabilities, bounded OSC 11 negotiation, CLI/settings precedence, and semantic light/dark/unknown surface mappings with True Color, 256-color, 16-color, and no-color fallbacks. Explicit schemes skip appearance queries and automatic appearance settles once within the shared startup window.

## Comments
