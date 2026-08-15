# Enforce strict pipeline exit semantics

Type: bug
Status: resolved
Priority: P0

Make the Bash Tool preserve upstream pipeline failure mechanically. Execute through an explicitly supported shell dialect with pipefail enabled and record the effective mode in observation facts. Do not assume every `$SHELL` accepts Bash flags.

## Acceptance

- `false | tail`, an exit-7 producer piped through `grep`/`head`, and the Boa-style `cargo ... | tail` pattern return nonzero Tool outcomes.
- A fully successful pipeline remains successful; a downstream failure remains an error; explicit shell handling such as a valid `||` follows the selected dialect.
- The Tool's `preview` option does not change exit status.
- Unsupported shells never silently fall back to last-command status: reject pipelines with a clear diagnostic or select a discovered supported shell explicitly.
- Facts expose the shell dialect and `pipelineStatusMode` for auditability; non-pipeline compatibility is covered.

## Ownership

Own `packages/coding-agent/src/tools/bash.ts` and Bash Tool tests. Keep changes to shell selection small and avoid `coda_agent.py` unless strictly necessary. None of the four audited agents enables pipefail by default (Grok even excludes it while restoring zsh options), so this is a Coda-owned safety design rather than a parity port.

## Comments

Resolved in `d61c9ca`: supported Shell pipelines use explicit pipefail semantics and expose the effective dialect and pipeline status mode in Tool observations.
