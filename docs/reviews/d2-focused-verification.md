# D2 Focused Independent Verification

Date: 2026-09-08

Scope: D2 scheduling policy, deterministic scheduler, and independent validator through the public domain interfaces. Implementation and the seven focused test files were confirmed frozen for the single authorized run. No implementation files were changed by verification.

Implementation revision: unavailable because the workspace has no resolvable Git `HEAD`. Verified frozen surfaces were `src/domain/canonical.ts`, `policy.ts`, `scheduling-rules.ts`, `schedule.ts`, `validation.ts`, and `index.ts`, with `tests/schedule-fixtures.ts` and the seven files below.

Versions: schema `canonical-v2`, schedule policy `schedule-mvp-v1`, validation policy `validator-mvp-v1`, and fixture revision `schedule-fixtures-v1`.

Fake-only boundary: all Places, Evidence, routes, geometry, durations, admission windows, and applicability records used by this run came from finite synthetic test fixtures. No provider adapter, network request, live credential, live map, browser, or real travel-fact assertion was exercised.

## Guarded Result

**PASS for the executed focused set.** Main granted one execution while no other resource-intensive command was active. The coder confirmed all D2 implementation, focused tests, and the shared fixture were frozen and launched no command during the run.

The runner resolved `node.exe` and `node_modules\vitest\vitest.mjs`, then invoked:

```text
scripts/run-guarded.ps1 -Executable $nodePath -ArgumentList @($vitestPath,'run','--maxWorkers=1','--no-file-parallelism','tests/policy.test.ts','tests/schedule.test.ts','tests/validation.test.ts','tests/schedule-temporal.test.ts','tests/schedule-numeric.test.ts','tests/schedule-policy-rules.test.ts','tests/schedule-scope.test.ts') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Result: exit `0`; 7/7 test files passed; 31/31 tests passed. Vitest duration was 8.15 seconds and command wall time was 9.79 seconds. No timeout, memory-limit, or process-limit diagnostic was emitted. Output contained the known Vite native-config warning and a jsdom setup performance note only. There was no retry and no increase to limits.

Execution ownership was explicitly returned to main immediately after completion. No typecheck, build, browser, network, or broader test command ran.

## Exercised Coverage

| D2 requirement | Result | Evidence |
| --- | --- | --- |
| Approved policy constants and structured override bounds | PASS | `tests/policy.test.ts` |
| Exact 160-minute two-Visit fixture; stable repeat result; short-window lunch assumption; no trailing rest | PASS | `tests/schedule.test.ts` |
| Exact 230-minute start/interior/end transfer fixture and 17:30 rejection | PASS | `tests/schedule-numeric.test.ts` |
| Included, partial, unknown, and excluded transfer-buffer arithmetic | PASS | `tests/schedule-numeric.test.ts` |
| Unknown route duration plus independent admission failure aggregation | PASS | `tests/schedule-numeric.test.ts` |
| Lunch/rest placement, fixed-Visit lunch conflict, disjoint openings, inclusive latest entry | PASS | `tests/schedule-policy-rules.test.ts` |
| Identity start transfer and hard walking treatment of unknown components | PASS | `tests/schedule-policy-rules.test.ts` |
| Owner duration precedence and one required-minimum conflict | PASS | `tests/schedule-policy-rules.test.ts` |
| Stale/unknown route rerouting, current-estimate warning, and departure applicability | PASS | `tests/schedule-temporal.test.ts` |
| Independent validator rejects malformed candidate, combined clock/provenance/route corruption, and extra ledger block | PASS | `tests/validation.test.ts` |
| Independent manual scheduled fixture and committed snapshot fixture validate | PASS | `tests/validation.test.ts` |
| Local scope preserves frozen unscoped day/facts and rejects unscoped changes | PASS | `tests/schedule-scope.test.ts` |

## Remaining Acceptance Gaps

These are **NOT_RUN**, not inferred passes. The existing `tests/d2-verification.test.ts` remains a todo inventory rather than executable coverage.

| Required D2 area | Status | Remaining risk |
| --- | --- | --- |
| Locked Visit removal, mutation, and pairwise-order corruption | NOT_RUN | Validator code was read, but no dedicated independent corruption matrix executed. |
| Free-day zero/one/two-boundary matrix, including differing and identical endpoints | NOT_RUN | One non-free identity start and one non-free two-boundary case passed; complete free-day semantics are unverified. |
| Exhaustive sourced duration precedence and unusable/stale/minimum/coverage combinations | NOT_RUN | One Owner-versus-source and required-minimum case passed; the full table is absent. |
| Required reservation/accessibility and wrong Place/field/date/revision Evidence binding combinations | NOT_RUN | Core rules exist, but the complete independent corruption matrix is absent. |
| Every route degradation row for both adjacency Legs and boundary transfers | PARTIAL / NOT_RUN | Representative route cases passed; the required cross-product is not exhaustive. |
| Bounded deterministic generated properties across multiple days | NOT_RUN | No generated suite was present in the authorized files. |

## Merge Assessment

The exercised D2 core is green and the validator is structurally independent from the scheduler. D2 does not yet satisfy the design's complete acceptance-test mandate because the matrices above remain unexecuted. Merge should retain those items as explicit test debt rather than treating the 31 focused passes as full AC-05/AC-06/domain AC-14 closure.
