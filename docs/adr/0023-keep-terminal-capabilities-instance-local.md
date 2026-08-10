---
status: accepted
---

# Keep Terminal capabilities instance-local

Keyboard protocol, color level, startup background appearance, synchronized output, key-release support, and size fallback are negotiated by each Terminal instance and exposed as an immutable capability snapshot. Automatic appearance uses a bounded OSC 11 query in the existing startup window and settles once; explicit light/dark configuration bypasses the query. Components receive normalized inputs and graceful fallbacks rather than consulting process-global protocol state, so real and virtual Terminal Adapters remain substitutable through the same Interface.
