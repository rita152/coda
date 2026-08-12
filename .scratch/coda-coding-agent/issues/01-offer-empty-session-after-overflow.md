# Offer an empty Session after Context Overflow

Status: resolved

Interactive Context Overflow currently fails closed and leaves the user in the
same oversized Session. Add an explicit action that closes the current Session,
opens a new empty Session for the same Workspace, rebuilds the Agent and prompt,
and preserves the old journal unchanged.

Acceptance criteria:

- definite local and provider-reported context overflow never truncate history;
- print mode remains exit `1`;
- interactive mode offers cancel or a new empty Session;
- the replacement receives a new Session identity and no implicit summary;
- VirtualTerminal and FileSessionManager integration tests cover the transition.

## Comments

Created from the initial `@coda/coding-agent` implementation pass.

Resolved on 2026-08-12. Auto-Compaction and the single safe Provider-overflow
retry remain first. When they cannot recover, interactive mode now offers only
cancel or a fresh empty Session in the same Workspace, closes the old Session
only after replacement construction succeeds, and carries no summary, Messages,
attachments, approvals, queued input, Run evidence, Compaction Checkpoint, Tool
state, or background process into the replacement. The old Session's owned
processes settle and write their audit facts before its journal closes. Print
mode still exits `1` without starting a terminal prompt.

Verified with VirtualTerminal and FileSessionManager integration coverage for
local overflow, Provider overflow, cancel, replacement, and replacement failure;
the old journal is compared byte-for-byte across cancellation and replacement,
and a live background-process fixture verifies Session-scoped retirement.
The complete `@coda/coding-agent` test suite and repository-wide `npm run check`
both pass.
