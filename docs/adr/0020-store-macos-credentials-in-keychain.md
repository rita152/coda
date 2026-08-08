---
status: accepted
---

# Store macOS Credentials in Keychain

The first persistent Credential Store uses macOS Keychain service `coda.cli.credentials.v1`, keyed by Provider ID; interactive flows may save or remove Credentials while print mode only consumes existing values. Other platforms remain environment-only until they receive a secure store, deliberately avoiding a portable plaintext auth file.
