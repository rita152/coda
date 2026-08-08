---
status: accepted
---

# Default Tools to sequential execution

Agent Tools execute sequentially unless a Tool explicitly declares itself parallel-safe. Validation and policy run in model-source order, execution events describe actual execution rather than rejected preflight, and parallel results are restored to source order before entering the transcript; this trades some automatic concurrency for deterministic and safer local side effects.
