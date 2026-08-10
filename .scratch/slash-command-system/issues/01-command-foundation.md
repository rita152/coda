# Build the Command Registry and Composer foundation

Type: task
Status: resolved

Implement the public Command Registry, parser, ranked search, source labels, and the application-owned Composer suggestion controller. Migrate the existing slash behavior onto definitions without moving application semantics into `@coda/tui`.

## Acceptance

- Case-insensitive exact and prefix matches rank ahead of fuzzy subsequence matches.
- Core commands are eligible only from Composer offset zero; Extension candidates are eligible at offset zero or after whitespace.
- Duplicate visible names remain separate by Command ID and source.
- Tab completes, Enter dispatches the selected candidate, and Escape preserves raw Prompt submission.
- `/permissions` remains a hidden alias; `/approvals` and `/attach` are removed.
- `/follow-up <text>` remains available only while the active Session is running.
- Tests observe behavior through Registry, Parser, and Composer seams.

## Comments

Claimed after the product semantics and module seams were confirmed through the grilling session.

## Answer

Implemented the unified Registry, Parser, Command Composer, Core command definitions, source-tagged Pi-style borderless upper list, shared nested Flow host, raw-Prompt fallback, and command-availability policy with unit and interactive coverage.
