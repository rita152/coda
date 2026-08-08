# OpenCode Go assembly and offline conformance

Type: task
Status: resolved

Assemble the OpenCode Go Provider, three-Api lazy dispatch, six-sentinel mock matrix, export audit, clean offline verification, and package dry run.

## Acceptance

- Build, check, default tests, and pack dry-run pass without real requests.
- Package contents and exports match the machine manifest exactly.
- Paid smoke tests remain skipped and reported as unverified.

## Comments

- Resolution evidence (2026-08-08): `opencode-go-provider.test.ts`, the six-sentinel catalog tests, export audits, default offline suites, and package dry-run verification cover Milestone 1 assembly; paid smoke tests remain explicit opt-in only.
