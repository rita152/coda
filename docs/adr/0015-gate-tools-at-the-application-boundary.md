---
status: superseded by ADR-0034
---

# Gate Tools at the application boundary

`@coda/coding-agent` owns an injected Policy Gate that defaults File Tools to the selected workspace, requests approval for outside/protected access and high-risk Shell, and fails closed when non-interactive use cannot obtain approval. The lower Agent sees only an allowed or rejected Tool Invocation; the Policy Gate is explicitly not a sandbox, so approved host execution retains the user's authority.
