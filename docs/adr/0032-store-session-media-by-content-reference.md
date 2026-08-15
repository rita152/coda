---
status: accepted
---

# Store Session media by content reference

Session formats beginning with v2 store validated Media Assets as mode-`0600`, content-addressed blobs and journal immutable references plus presentation metadata instead of inline base64. The versioned Session migration registry writes, syncs, validates, and atomically installs a complete current-format journal while retaining a recoverable backup of the original version; this preserves local-first durability without allowing images to inflate or partially corrupt the linear Session journal.
