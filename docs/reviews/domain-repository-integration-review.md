# Domain And Repository Integration Review

Status: Open implementation review, 2026-09-08. These findings are not
acceptance passes. Independent verification is in progress.

## D1 Requirement Assessment

Main inspected `src/domain/brief.ts` and `src/domain/canonical.ts` after the
initial D1 handoff. The existing happy-path suite does not establish full
design 0003 Section 4 coverage.

- An unresolved destination currently has no blocking issue.
- Required end boundaries and unresolved requested boundary references are
  not assessed alongside required start boundaries.
- Date-only ranges do not receive effective day-count scope validation.
- Missing optional fields do not produce the specified visible defaults;
  assessment only returns assumptions already present in the input.
- Density conflict checking depends on a pace preference even when the
  conflicting constraints are explicitly hard.
- Window and fixed-start contradictions need independent coverage.
- Evidence field/value binding and nested snapshot immutability need
  verification against the strict canonical contract.

Tester owns independent reproductions in `tests/d1-verification.test.ts`.
Implementation fixes remain with the D1 coder after verification. Scheduler
and typed-edit work must not be declared complete through these D1 tests.

## Repository

Main inspected the in-progress `src/server/repository/index.ts` and routed
the following findings to its coder:

- Idempotency must compare the canonical strict Turn, not interpreted
  `kind` or reduced `brief`, so a repeated input remains replayable.
- A normal checkpoint must not finalize successful generation without
  the atomic version commit or explicit no-change operation.
- Caller event fields must not override the trusted Run and Turn binding.
- Supersession needs a durable terminal event in the acceptance transaction.

Recovery, bound clarification, retry, no-change completion and independent
multi-connection SQLite verification remain outstanding at this checkpoint.

## Observed Check

`npm run typecheck` passed against the current worktree during this review.
This establishes TypeScript compatibility only, not correctness, security,
provider integration, or a phase exit.
