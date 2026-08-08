---
status: accepted
---

# Align the Coda AI contract with Pi AI

`@coda/ai` will preserve an explicit subset of the public API, types, and observable behavior of `/Users/zp/Desktop/pi/packages/ai` at commit `958c13f25080b59d4b736193f972a8502a7a2f8b`, rather than inventing a new abstraction. A frozen baseline gives the package a testable contract and lets Coda focus its original work on the coding-agent experience without silently inheriting later Pi changes.

Compatibility is profile-based until the entire public surface is implemented: Milestone 1 does not claim that `@coda/ai` is a drop-in replacement. The maintained profile lives in `.scratch/coda-ai/spec.md`.
