Type: task
Status: resolved

# Verify platforms and deliver main

Run the complete unit matrix and macOS escape suite, add four-platform GitHub Actions jobs, update GitHub `main` with an exact force lease, and fix failures until macOS and Linux x64/arm64 are green.

## Comments

- Local macOS arm64 acceptance passed on 2026-08-10: static checks, 575 unit tests, 3 coding-agent integration tests, 10 real Sandbox escape tests, 3 CLI E2E tests, package dry-runs, and `git diff --check`.
- GitHub `main` was replaced with the approved exact force lease and then advanced normally through CI fixes.
- Final acceptance passed on 2026-08-10 for macOS arm64/x64 and Linux arm64/x64 in [CI run 31337879809](https://github.com/rita152/coda/actions/runs/31337879809), including static checks, the unified unit matrix, real platform Sandbox escape tests, CLI E2E tests, and package dry-runs.
