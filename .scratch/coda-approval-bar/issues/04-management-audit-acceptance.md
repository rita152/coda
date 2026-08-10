# Integrate approval management, audit, and acceptance

Type: task
Status: resolved
Blocked by: 01, 02, 03

Add `/approvals`, compact Tool Invocation audit projection, historical expiry, diagnostics ordering, documentation updates, and end-to-end verification.

## Acceptance

- Active Session Approvals can be listed and revoked while idle.
- Approval outcomes survive Session restore without restoring authority.
- Teardown and fatal paths audit abort rather than denial.
- Coding Agent/TUI checks, repository tests, integrations, and macOS PTY smoke pass.

## Answer

Added idle `/approvals` list/revoke management, compact approval audit correlation with Tool Invocations, expired restored process grants, bounded Unicode-safe denial summaries, and termination/fatal abort handling. Final verification passed all workspace checks, 614 unit tests, 13 applicable integration tests, and all 4 macOS PTY scenarios; 9 Linux-only integration cases remained skipped by the existing platform gate.

## Comments
