---
status: accepted
---

# Structure terminal input at the adapter boundary

`ProcessTerminal` owns ANSI and keyboard-protocol parsing and emits structured key, text, paste, and resize inputs to the TUI. Real and virtual Terminals share the same asynchronous, idempotent lifecycle and input contract, preventing Components and tests from depending on raw escape sequences or process-global protocol state.
