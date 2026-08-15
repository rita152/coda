---
status: accepted
---

# Align the Coda AI contract with Pi AI

`@coda/ai` will preserve an explicit subset of the public API, types, and observable behavior of `/Users/zp/Desktop/pi/packages/ai` at commit `958c13f25080b59d4b736193f972a8502a7a2f8b`, rather than inventing a new abstraction. A frozen baseline gives the package a testable contract and lets Coda focus its original work on the coding-agent experience without silently inheriting later Pi changes.

Compatibility is profile-based until the entire public surface is implemented:
Milestone 1 does not claim that `@coda/ai` is a drop-in replacement. The exact
maintained profile is [`manifest.v1.json`](../../packages/ai/compatibility/manifest.v1.json),
with a readable projection in the
[`@coda/ai` compatibility README](../../packages/ai/compatibility/README.md).
The `.scratch/coda-ai/` files are historical implementation records.
