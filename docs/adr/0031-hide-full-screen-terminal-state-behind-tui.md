---
status: accepted
---

# Hide full-screen terminal state behind the TUI

`@coda/tui` owns a deep FullScreenTui Module that hides alternate-buffer, autowrap, cursor, synchronized-frame, viewport, animation, and cleanup ordering behind one interface while `ProcessTerminal` remains the raw-input Adapter. Keeping escape-sequence orchestration out of Coding Agent presentation preserves locality, makes the same interface the test seam, and prevents every full-screen caller from relearning failure-prone terminal lifecycle rules.
