# Match the Codex approval overlay source

Type: task
Status: resolved

Replace the screenshot-inferred Approval Bar presentation with behavior derived directly from the project's declared Codex reference checkout at commit `f93109615ff27ab58007601434b27c940d5500c7`.

## Acceptance

- Layout matches `approval_overlay.rs`, `list_selection_view.rs`, and `selection_popup_common.rs`: content-height surface, 2×1 insets, grouped blank rows, and a footer outside the surface.
- The first option is selected, selected text uses the shared bold accent without a separate background, option numbers remain sequential when the prefix choice is absent, and feedback/Escape map to Codex cancellation.
- Title, Environment, Reason, Additional Permission rule, command, choices, shortcuts, and footer follow the Codex hierarchy and copy, substituting only the Coda product name.
- Light, dark, reduced-color, NO_COLOR, virtual-terminal snapshot, and real PTY coverage pass.

## Answer

Reworked the command Approval Bar against the local Codex source instead of the screenshot alone. Coda retains its stricter request snapshotting, paste immunity, terminal-size lockout, process-local prefix validation, executable-identity binding, FIFO handling, and audit semantics beneath the Codex-compatible surface.

## Comments
