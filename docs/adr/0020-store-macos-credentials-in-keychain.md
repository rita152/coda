---
status: accepted
---

# Store macOS Credentials in Keychain

The first persistent Credential Store uses macOS Keychain service
`coda.cli.credentials.v1`, keyed by Provider ID. Linux later gained the same
policy through Secret Service via `secret-tool`. Interactive flows may save or
remove Credentials while print mode only consumes existing values. If a
supported platform store is unavailable, Credentials remain process-local;
Coda never falls back to a portable plaintext auth file.
