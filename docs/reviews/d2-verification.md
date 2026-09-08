# D2 Independent Verification

Date: 2026-09-08

Status: focused verification `passed`; latest D2 and domain regressions passed

## Scope

The independent AC-05/AC-06 suite uses only public domain exports and the stable,
finite fixtures in `tests/schedule-fixtures.ts`.

## Independent Matrix

- Accept the hand-authored schedule without using scheduler output as the
  validator oracle.
- Aggregate Visit-clock, ledger-timeline, duration-provenance,
  reversed-endpoint, and wrong-route-fact tampering.
- Reject an unaccounted fabricated block with a finite interval.
- Permit missing route geometry only as a Warning while duration and walking
  components still prove applicable limits.
- Reject unknown walking components when explicit hard caps require proof.

The completed guarded focused D2 domain run covered 7 files and 31 tests, including
exact arithmetic, boundaries, lunch/rest, route-required, free-day, scope,
admission, and schema behavior. This independent file avoids repeating those
happy paths and cross-checks hand-mutated canonical candidates instead.

## Focused Verification

Main granted sole execution ownership for one guarded focused run. The exact
suite contained `tests/d2-verification.test.ts`, `tests/d1-verification.test.ts`,
`tests/brief.test.ts`, `tests/contracts.test.ts`, and `tests/canonical.test.ts`,
with one worker and file parallelism disabled under the default 1536 MiB,
120-second, 8-process guard.

Observed result: guard/process exit `1`; 5 files; 102 tests; 98 passed and 4
failed in 5.98 seconds (7.66 seconds guarded wall time). No guard timeout,
resource-limit, or process-count diagnostic was emitted. The Vite native config
loader warning was non-fatal.

Failures:

- D2 combined tampering produced `candidate.schema` before semantic validator
  issue codes because the combined wrong-mode mutation violates the canonical
  candidate schema.
- D2 fabricated block produced `ledger.entry_buffer` and
  `ledger.semantic_order`, not the asserted `ledger.extra_block` and
  `ledger.timeline`; the copied block retained an existing Visit reference.
- D2 hard-walking fixture used invalid ID `walking_cap`; hard-constraint IDs
  must match the `constraint_...` contract.
- The D1 Evidence-closure regression fixture failed earlier canonical-v2 shape
  checks, so its thrown Zod message did not match `/Evidence/i`.

No retry, limit increase, other suite, build, typecheck, browser, or network
operation was performed. Execution ownership was returned to main after this
failed run.

## Corrected Fixtures

After the failed run, the owned fixtures were corrected without execution:

- strict candidate-schema corruption is now tested separately from a parsable
  semantic mutation;
- the semantic candidate retains valid clocks while independently corrupting
  duration provenance, route fact content, and Leg endpoints;
- the fabricated block is an unbound `break`, rather than a copied Visit entry
  buffer;
- the walking-cap constraint ID now satisfies the canonical ID contract;
- the D1 Evidence-closure case now starts from a complete canonical-v2 committed
  snapshot and changes only one Visit to reference absent Evidence.

At that point these corrected tests were finite and static `ready`; their later
execution result is recorded below.

## Latest Focused Verification

The corrected D2/D1 files were run once with the four requested domain
regression files and the frozen Composition suite. The guarded command used one
worker, disabled file parallelism, and retained the default 1536 MiB,
120-second, 8-process limits.

Observed result: guard/process exit `1`; 6 files; 156 tests; 155 passed and 1
failed in 7.16 seconds (8.79 seconds guarded wall time). No timeout, memory, or
process-count diagnostic was emitted. The Vite native config-loader warning was
non-fatal.

The sole failure is a D2 fixture-classification error in
`rejects strict-schema tampering before semantic validation`. Changing a Visit
end clock remains valid canonical shape, so the independent validator correctly
reached semantic checks and returned `ledger.visit` rather than
`candidate.schema`. This is not evidence of a production implementation defect.
The other five D2 independent cases, the repaired D1 Evidence-closure case, all
four requested domain regression files, and `tests/composition.test.ts` passed.

No retry or post-failure production edit was performed. Execution ownership was
returned to main.

## Corrected Baseline Result

The arithmetic/schema split was corrected and included in the next authorized
guarded run. All 7 independent D2 tests passed, along with every test in
`tests/d1-verification.test.ts`, `tests/brief.test.ts`, `tests/contracts.test.ts`,
and `tests/canonical.test.ts`. These five files contributed 104 passing tests
with no failures.

The complete six-file process also included `tests/repository.test.ts`, so its
overall exit was `1`: 152 tests total, 116 passed and 36 failed. Every failure
was in the Repository file and shared an invalid `turnId` fixture precondition;
none was a D2 failure. Vitest duration was 9.70 seconds and guarded wall time
was 11.35 seconds. No timeout, memory, or process-count diagnostic was emitted.

No retry, limit increase, production edit, or assertion relaxation followed.
Execution ownership was returned to main.

Success would establish only deterministic scheduling arithmetic and pure
validator behavior against synthetic facts pinned to `schedule-mvp-v1`,
`schedule-fixtures-v1`, and `validator-mvp-v1`. It would not prove route truth,
provider capability, persistence, authorization, workflow, browser behavior, or
live readiness.
