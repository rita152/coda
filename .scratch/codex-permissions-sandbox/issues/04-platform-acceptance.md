Type: task
Status: claimed

# Verify platforms and deliver main

Run the complete unit matrix and macOS escape suite, add four-platform GitHub Actions jobs, update GitHub `main` with an exact force lease, and fix failures until macOS and Linux x64/arm64 are green.

## Comments

- Local macOS arm64 acceptance passed on 2026-08-10: static checks, 575 unit tests, 3 coding-agent integration tests, 10 real Sandbox escape tests, 3 CLI E2E tests, package dry-runs, and `git diff --check`.
- Linux x64/arm64 and macOS x64 CI acceptance, exact-lease `main` delivery, and final four-job verification remain in progress.
