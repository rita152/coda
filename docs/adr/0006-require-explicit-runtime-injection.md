---
status: accepted
---

# Require explicit runtime injection

Coda packages must not mutate process-global behavior when imported. Model runtimes, stream functions, credentials, keybindings, settings, clocks, ID generators, and platform adapters are supplied through constructors or explicit factories, accepting additional composition at the application boundary in exchange for isolation, deterministic tests, and independently reusable packages.
