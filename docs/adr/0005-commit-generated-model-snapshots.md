---
status: accepted
---

# Commit generated model snapshots

OpenCode Go model metadata will be refreshed from models.dev only by an explicit `models:update` operation, validated and atomically written, then committed for review. Ordinary builds remain offline and reproducible; Coda freezes the transformation rules rather than the upstream model list, and refresh failures never replace the last valid snapshot.
