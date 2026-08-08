---
status: accepted
---

# Keep Terminal capabilities instance-local

Keyboard protocol, color level, synchronized output, key-release support, and size fallback are negotiated by each Terminal instance and exposed as an immutable capability snapshot. Components receive normalized inputs and graceful fallbacks rather than consulting process-global protocol state, so real and virtual Terminal Adapters remain substitutable through the same Interface.
