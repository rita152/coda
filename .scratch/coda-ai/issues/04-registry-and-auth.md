# Registry and authentication

Type: task
Status: resolved

Implement `CredentialStore`, `ModelsError`, `createProvider`, `createModels`, static refresh, mixed-Api dispatch, and the frozen Credential precedence.

## Acceptance

- Stored incompatible Credentials fail without environment fallback.
- Unsupported deferred and OAuth behavior fail with their specified structured errors.
- Authentication/setup failures terminate streams rather than escaping synchronously.

## Comments

- Resolution evidence (2026-08-08): `create-provider.test.ts`, `models.test.ts`, `models-error.test.ts`, and `credentials.test.ts` cover registry dispatch, precedence, static refresh, and fail-closed unsupported behavior.
