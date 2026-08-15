---
status: accepted
---

# Own neutral execution ports at their consumers

Coda keeps Provider-specific timing inside `@coda/ai`, but no longer treats that package's `TimeRuntime` as repository-wide vocabulary. Agent, Runtime, and TUI own the smallest structural Clock, sleep, randomness, or scheduling ports their behavior actually consumes, and application composition may satisfy several of those compatible ports with one system implementation. This supersedes ADR-0047's single-Time clause: the consumers change independently, and making terminal or orchestration code import a Model Provider foundation hides the real dependency rather than sharing policy. A ninth utility package was rejected because these structural seams need no shared implementation owner.
