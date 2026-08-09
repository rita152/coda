---
status: accepted
---

# Store Session media by content reference

Session formats beginning with v2 store validated Media Assets as mode-`0600`, content-addressed blobs and journal immutable references plus presentation metadata instead of inline base64. The current v3 migration writes, syncs, validates, and atomically installs a complete journal while retaining a recoverable versioned backup; this preserves local-first durability without allowing images to inflate or partially corrupt the linear Session journal.
