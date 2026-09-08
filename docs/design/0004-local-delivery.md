# Local Delivery

Status: Approved implementation scope for the user's runnable-project goal.
This supplements design 0001 without changing any product acceptance gate.

## Deliverables

- `README.md`: Chinese quick start, desktop-only scope, actual implemented
  versus pending capabilities, commands, architecture pointers, credential
  boundaries and test evidence links. Do not describe fixture mode as live.
- `requirements.md`: Node/npm prerequisites, lockfile as the exact dependency
  manifest, local SQLite storage, provider capabilities, and AC-01
  through AC-17 traceability to the canonical acceptance matrix. This is a
  TypeScript project; do not invent Python requirements.txt dependencies.
- `scripts/start.ps1` plus a `start.cmd` wrapper: foreground Windows launcher
  with development and production modes, validated host/port, dependency
  installation when missing, production build before production start,
  checked exit codes, and a printed local URL. Never kill another listener.
  An occupied port must fail clearly and accept an alternate explicit port.
  Resolve project paths from the script, not the caller's working directory.
  Foreground operation permits normal Ctrl+C shutdown without hidden services.
- `scripts/verify.ps1`: run typecheck, lint, unit tests, production build and
  browser tests in order, stop on first nonzero exit. Browser installation is
  an explicit setup option, not silently skipped coverage.
- `.env.example`: names and empty values only for future provider and database
  configuration, with browser/server AMap capabilities clearly distinguished.
  No actual credentials, invented model availability, or ignored live errors.
  Use `DATABASE_PATH` for local SQLite storage; no Docker or external database
  server is required. Startup schema initialization is implemented alongside
  persistence and must be verified before claiming that delivery gate.

## Verification

Exercise launcher argument validation, paths containing spaces, occupied port,
verification fail-fast behavior and a real HTTP startup/shutdown smoke check.
Use automated tests where practical, record manual observations otherwise.
Do not start live paid adapters or capture environment values in test output.
Document missing external prerequisites honestly. Full release readiness
continues to require every applicable gate in design 0001.

Repository initialization and final packaging follow the secret/artifact audit.
Do not initialize or modify a parent repository, create a remote, or publish.
