---
status: accepted
---

# Encode structured stream errors as Diagnostics

Coda preserves Pi's terminal error-event and Assistant Message shapes while attaching a structured Diagnostic to every non-cancellation stream failure. Codes and safe provider/request context remain machine-readable alongside the compatible `errorMessage`; persisted Messages omit stack traces by default, and normal cancellation remains an `aborted` outcome rather than an error.
