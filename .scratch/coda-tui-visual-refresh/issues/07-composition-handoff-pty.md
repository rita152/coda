# Complete composition, handoff, and PTY verification

Type: task
Status: resolved
Blocked by: 01, 02, 03, 04, 05, 06

Enable full-screen as the only interactive TTY mode, resolve Theme and motion settings, produce the compact main-screen handoff, update CLI help, and complete protocol/cell-grid/PTY verification.

## Acceptance

- Print and JSON modes never enter alternate screen.
- Interactive mode starts full-screen by default and has no regular TUI fallback.
- Clean exit prints only the agreed handoff.
- Reduced motion schedules no animation loop; NO_COLOR emits no SGR.
- A PTY smoke verifies entry, input, resize, exit, protocol cleanup, cooked mode, and a post-exit shell sentinel.

## Comments

## Answer

Enabled full-screen as the only interactive TUI, added responsive Theme/motion composition and compact unlabeled handoff, updated CLI help, shared signal/suspend cleanup across first-run selection, authentication, trust, and chat screens, and verified entry/input/resize/SIGTERM/cleanup/cooked-mode behavior through a real macOS PTY.
