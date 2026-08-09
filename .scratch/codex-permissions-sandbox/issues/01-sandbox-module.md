Type: task
Status: resolved

# Implement the Sandbox module seam

Create `@coda/sandbox`, freeze the compiled Permission Profile contract, implement process-tree lifecycle and macOS/Linux adapters, and verify real confinement through the public `execute` interface.

## Comments

- Implementation began on 2026-08-10.

## Answer

Implemented `@coda/sandbox` with a frozen compiled-policy contract, canonical multi-root support, streamed execution, cancellation, timeout, output limits, and whole-process-tree ownership. The macOS adapter generates Seatbelt profiles through `/usr/bin/sandbox-exec`; the Linux adapter uses bubblewrap plus an auditable native launcher for namespace, `no_new_privs`, seccomp, and managed-proxy setup. Restricted profiles fail closed, protected metadata and precise nested write reopening are covered, and licenses/provenance are included in the package.

Verified on 2026-08-10 with 26 package unit tests and 10 real macOS escape tests through the public `execute` seam. Linux escape acceptance remains tracked by issue 04 and CI.
