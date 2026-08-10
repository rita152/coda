# Replace the command modal with the Approval Bar

Type: task
Status: resolved
Blocked by: 01, 02

Build the bottom full-width command Approval Bar, safe information presentation, keyboard state machine, responsive detail handling, and lifecycle cleanup.

## Acceptance

- The first decision is selected like Codex and pasted input cannot approve.
- Codex-compatible direct keys, sequential numbering, navigation, denial, and abort behavior work through the TUI seam.
- Unsafe terminal sizes cannot grant authority.
- Resize and suspend/resume preserve active interaction state.
- Light/dark/unknown/NO_COLOR snapshots match the specification.

## Answer

Replaced interactive command modals with a source-aligned reproduction of Codex's bottom Approval Bar at `f93109615ff27ab58007601434b27c940d5500c7`: content-driven height, 2×1 menu insets, grouped whitespace, uniform surface background, bold cyan selection, default first choice, sequential numbering, original shortcut/footer copy, cancel-to-feedback behavior, paste immunity, unsafe-size lockout, and abort-safe teardown. Selection, scroll, and focus survive resize and terminal suspend/resume.

## Comments
