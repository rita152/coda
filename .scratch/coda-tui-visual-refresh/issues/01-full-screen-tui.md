# Build the FullScreenTui Module

Type: task
Status: resolved

Introduce the `@coda/tui` full-screen seam, height-aware render context, alternate-buffer lifecycle, synchronized frame renderer, and strict test screen model.

## Acceptance

- Interactive startup and shutdown emit correctly ordered, paired terminal protocols.
- Cleanup is idempotent across normal stop, startup failure, exception, signal, and suspend/resume.
- Renderables receive width, height, and injected time.
- Resize forces a correct full redraw without stale cells.
- Tests exercise behavior through FullScreenTui and the screen model.

## Comments

Blocked by: none.

## Answer

Implemented the alternate-buffer lifecycle, height-aware render context, synchronized differential frames, idempotent cleanup, resize redraw, and strict screen model. Unit, integration, and PTY lifecycle verification pass.
