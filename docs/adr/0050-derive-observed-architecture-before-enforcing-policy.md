---
status: accepted
---

# Derive observed architecture before enforcing policy

Coda discovers workspace manifests and static module edges before comparing them with explicit architecture policy. Builds use the discovered workspace dependency graph in stable dependency-first order; boundary checks fail closed when a discovered workspace is missing from policy, when policy names a missing workspace, or when a real dependency violates the allowed DAG. Runtime fan-out and direction checks operate on resolved module edges and expand re-exports, so a barrel cannot disguise knowledge. Hand-written allowlists remain the intentional policy, but they are never the source of what exists. This supersedes ADR-0047's path/count-based enforcement mechanism. ADR-0055 later expanded the workspace set; the discover-then-compare rule is unchanged.
