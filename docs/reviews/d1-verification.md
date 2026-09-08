# D1 Independent Verification: Initial Red Phase

Date: 2026-09-08

Scope: public Brief reducer/assessment and canonical contracts for D1, bounded to AC-01 and the domain-input portion of AC-07. No implementation files were changed.

## Result

**FAIL.** The focused suite ran 17 tests: 2 passed and 15 failed. The failures reproduce ten D1 requirement gaps.

Command:

```text
npm test -- --run tests/d1-verification.test.ts
```

Result: exit 1, 1 failed file, 15 failed tests, 2 passed tests.

## Reproducible D1 Findings

| Bounded requirement | Result | Reproduction | Observed behavior |
| --- | --- | --- | --- |
| AC-01 unresolved destination blocks | FAIL | `tests/d1-verification.test.ts:45` | `assessRequirements` returns duration/date issues but no destination issue for `status: "unresolved"`. |
| AC-01 required boundaries | PARTIAL FAIL | `tests/d1-verification.test.ts:58` | Missing required start is detected; missing required end is accepted. |
| AC-01 requested boundary grounding | FAIL | `tests/d1-verification.test.ts:65` | Unresolved requested start and end references are both ignored. |
| AC-01 date-only duration scope | FAIL | `tests/d1-verification.test.ts:74` | Inclusive 8-day range with null explicit day count returns no unsupported-duration issue. |
| AC-01 visible assumptions | FAIL | `tests/d1-verification.test.ts:79` | Absent dates/window/pace/mode/companions/budget/meals/lodging/boundaries produce no default assumptions. |
| AC-01 hard density conflict | FAIL | `tests/d1-verification.test.ts:87` | Minimum 4 and maximum 3 is accepted when pace preference is null; hard conflict is incorrectly preference-gated. |
| AC-01 window/fixed-time conflicts | FAIL | `tests/d1-verification.test.ts:97` | Reversed day window and fixed start outside a hard allowed window produce no issues. |
| D1 canonical duration bound | FAIL | `tests/d1-verification.test.ts:110` | Explicit 1440-minute duration override parses although supported stay range is 1-1439. |
| D1 Evidence field/value contract | FAIL | `tests/d1-verification.test.ts:114` | Incompatible values parse for opening windows, closure dates, latest entry, and reservation requirements because field/value are not discriminated. |
| D1 immutable canonical records | FAIL | `tests/d1-verification.test.ts:128` | Parsed Brief is only partially frozen; destination and other nested records remain mutable. Reducer nested preferences test passes. |
| AC-07 internal Evidence closure | FAIL | `tests/d1-verification.test.ts:139` | Committed snapshot accepts Visit Evidence IDs absent from its complete frozen Evidence set. |

The second passing case is required-start-missing detection. Existing strict parsing and reducer nested preferences freezing are therefore covered but do not close the broader failures above.

## Broader Checks

```text
npm run typecheck
```

Exit 1 before D1 test typing because concurrent implementation has a syntax error at `src/server/repository/index.ts:437` (`TS1005: ')' expected`). This file is outside verifier ownership and was not changed.

```text
npm test -- --run
```

The initial run before removing an over-scoped draft-membership assertion exited 1 with 52 tests passed and 16 D1-file failures; `tests/repository.test.ts` could not load because of the same unrelated parse error. The final focused command above is authoritative. Vitest also prints the pre-existing Vite native-config warning.

## Scope Boundary

Not claimed as D1 failures: candidate-set membership for syntactically valid draft Evidence/duration-option IDs (requires validator/input context), scheduler arithmetic, route/boundary-transfer validation, admission applicability enforcement, source entailment, model refusal/retry budgets, Typed Commands, and snapshot construction behavior beyond internal D1 canonical reference closure. The design assigns those to D2, D3, or Phase 4/5. No live calls or credentials were used.

Historical merge risk at the initial red phase was high: the then-current public
gate could allow unresolved destination/boundary requirements and contradictory
Hard Constraints through, while canonical inputs could retain unsupported
durations, mismatched Evidence values, mutable nested records, and internally
dangling Evidence references. The latest focused result below supersedes this as
the current implementation status without erasing the earlier evidence.

## Latest Focused Verification

Implementation handoff under review: coder revision `01a07ce5...` (identifier as
reported by main; not independently resolved during this no-execution task).

Status: `pass` for the latest focused D1 implementation.

The historical failures above describe the earlier implementation and remain
preserved as such. The latest `tests/d1-verification.test.ts` adds finite,
independent coverage through the public D1 interfaces for:

- inclusive Gregorian arithmetic across ordinary year, non-leap-century,
  leap-century, and leap-day boundaries;
- exact-date readiness from start date plus supported day count, with a derived
  effective end date that is not persisted into the Brief;
- aggregation of multiple allowed-window intersections and contradictory fixed
  starts;
- the tightest maximum across multiple `visit_count` and `max_visits` Hard
  Constraints;
- resolved must-visit/start/end references that lack grounding in the supplied
  Place context;
- deep freezing of nested arrays and records supplied beneath an already-frozen
  parent.

Main granted exclusive ownership for one focused guarded run after confirming the
calendar loops and test producers were bounded. The three test files contain only
small finite tables and fixed object traversals; no stream, timer, generated
growth, or unbounded producer was present.

Command:

```powershell
$nodePath = (Get-Command node.exe).Source
$vitestPath = (Resolve-Path 'node_modules\vitest\vitest.mjs').Path
& '.\scripts\run-guarded.ps1' -Executable $nodePath -ArgumentList @($vitestPath,'run','tests/brief.test.ts','tests/canonical.test.ts','tests/d1-verification.test.ts','--maxWorkers=1','--no-file-parallelism') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Observed result:

- Guard/process exit: 0
- Test files: 3 passed, 3 total
- Tests: 71 passed, 71 total
- Vitest duration: 4.91 seconds
- Resource-limit or timeout diagnostic: none

The run emitted the existing non-failing Vite warning about ESM syntax loaded as
CommonJS under future native config loading. Vitest also reported that jsdom was
created three times and suggested optional test-environment performance tuning;
this is not a correctness failure.

The latest focused evidence passes the assigned D1 AC-01 and domain-input AC-07
scope, including the independent boundary cases listed above. Historical initial
failures earlier in this report remain evidence against the earlier implementation,
not the current result. D2 scheduling/validation, repository isolation, workflow,
provider grounding, and browser behavior remain outside this D1 claim.

No build, typecheck, browser, network, legacy launcher, or other test suite ran.
Execution ownership was returned to the main thread after completion.
