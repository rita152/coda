---
status: accepted
---

# Keep the Agent reducer internal

Agent state reduction and arbitrary event dispatch remain internal seams rather than public exports added for testing or persistence. Callers drive the Agent through its behavioral Interface, observe immutable events and snapshots, and restore only from a validated Agent Seed, preventing forged events and implementation-specific state transitions from becoming permanent caller knowledge.
