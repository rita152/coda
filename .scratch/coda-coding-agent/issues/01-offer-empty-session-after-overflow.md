# Offer an empty Session after Context Overflow

Status: ready-for-agent

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
