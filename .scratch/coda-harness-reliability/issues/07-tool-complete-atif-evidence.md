# Preserve complete Tool steps in ATIF and paged evidence

Type: bug
Status: ready-for-agent
Priority: P1

Generate a diagnostically complete ATIF trajectory from semantic terminal events and write large, redacted Tool payloads/results to a streamable `tool-evidence.jsonl` artifact. Keep compact RunEvidence bounded; link trajectory steps to evidence by stable invocation ID/reference.

## Acceptance

- Mixed and parallel Tool traces preserve chronological/source sequence, call/result pairing, invocation ID, Tool name, status, settlement, exit/signal/timeout, and completeness.
- Large payloads/results are bounded in ATIF and retrievable by stable refs from the external evidence stream.
- Credentials/secrets are redacted and terminal control sequences neutralized.
- Partial traces without `run_end` still produce valid, explicitly partial artifacts.
- A 100+ command fixture retains every terminal Tool record independent of RunEvidence's 32-command summary limit.
- Output validates against the locked ATIF/Pier schema and is generated with streaming/bounded-memory logic.

## Ownership and dependencies

Prefer new `packages/evals/pier/coda_trajectory.py`. Rebase onto 04's artifact lifecycle and consume 06's semantic stream. Keep `coda_agent.py` integration small; do not solve this by increasing `MAX_COMMANDS`.
