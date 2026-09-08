# Release Readiness

Status: NOT READY. This tracks the complete user objective, not just Phase 1.
The canonical test expectations remain design 0001 Section 20.

## Required Deliverables

| Deliverable | Current evidence |
| --- | --- |
| Desktop Web library, itinerary, day detail and map | Phase 1 fixture verification exists; integrated runtime pending |
| Natural-language planning, research and grounded routes | Not implemented/verified |
| Multi-turn revisions, isolated persisted history | SQLite focused tests passed 48/48 and H1 handlers 11/11; full conversation/workflow unverified |
| Recovery, cancellation, retry and SSE replay | Repository focused tests passed 48/48; executor unverified |
| Windows startup and verification scripts | Historical delivery verification passed 9 tests and dev HTTP smoke; current scripts bypass the new guard and remain execution-gated; SQLite initialization and production runtime repeat pending |
| README and requirements | Present and reviewed for fixture scope; update as runtime integration completes |
| Standalone Git project and distributable source | Pending source/secret audit and initialization |
| All functional acceptance gates | Incomplete; matrix below |

## Acceptance Status

| IDs | Status | Evidence / missing scope |
| --- | --- | --- |
| AC-01 | partial | D1 focused verification passed 71 tests across three files under guard on 2026-09-08; full workflow admission and zero-paid-call gate remain pending |
| AC-02 | partial | Interpretation module passed 38 synthetic tests; persisted Q&A, new Trip dispatch and bound clarification workflow pending |
| AC-03, AC-04 | not_run | Deterministic and semantic revision gates pending |
| AC-05, AC-06 | partial | D2 focused 31 tests and D3 compatibility batch 215 tests passed; full workflow feasibility remains pending |
| AC-07 | partial | Pure provider-policy verification passed 99 tests; DeepSeek structured adapter passed 96 finite fake-transport tests under guard on 2026-09-08; supplied-ID composition and durable workflow enforcement pending |
| AC-08, AC-09 | partial | H0 passed 53 tests; SQLite focused 48 tests, D3 compatibility batch and H1 handler 11 tests passed; actual Next route wiring, cookie browser behavior and workflow integration remain unverified |
| AC-10 | not_run | Durable repository in progress; executor/crash/SSE tests pending |
| AC-11 | not_run | Persistent snapshot/cache/version tests pending |
| AC-12 | partial | Phase 1 report passed fixture scope only; runtime repeat required |
| AC-13 | blocked | Browser credential capability/security configuration unverified |
| AC-14 | not_run | Evidence applicability, entailment and injection checks pending |
| AC-15 | partial | Pure budgets/retry/freshness passed 99 tests; DeepSeek adapter passed 96 tests including deadlines, bounded consumption, normalized retry hints and error redaction; durable reservations, live capabilities and full release redaction remain unverified |
| AC-16 | not_run | Versioned prompts, fixed eval and human quality review pending |
| AC-17 | not_run | Fake full workflow and separate live scenario both pending |

## External Inputs

- DeepSeek endpoint/model metadata was supplied; model availability and live
  capabilities have not been verified. No active provider environment variable
  names were found during this continuation; no values were printed or recorded.
- AMap supplied key capability has not been confirmed. Browser and server keys
  are distinct; security configuration and server credential remain unresolved.
- Web research provider still needs an integration decision. Concrete ceilings
  are approved in design 0007, but durable budget enforcement and live
  capability checks remain unverified. No silent fixture fallback is permitted
  in live mode.

SQLite is user-approved. No Docker or PostgreSQL prerequisite remains.
Missing external inputs do not block independent domain/repository/fake work.

Focused delivery evidence: [delivery-verification.md](delivery-verification.md).
Its production-order tests use process shims; they do not prove a production
HTTP server or database startup. Those checks remain required at integration.

Current domain/repository findings:
[domain-repository-integration-review.md](domain-repository-integration-review.md).
D1 focused evidence is recorded in [d1-verification.md](d1-verification.md).
Its 71 passing tests cover domain input/gate behavior, not full workflow
admission, scheduling feasibility or provider integration.

Resource safety acceptance is recorded in
[guarded-runner-verification.md](guarded-runner-verification.md); its finite
allocation-denial result is not a whole-machine memory guarantee. H0 results
are recorded in [h0-verification.md](h0-verification.md). Neither closes the
complete browser, isolation, recovery, or live-provider acceptance scope.

Provider policy evidence is recorded in
[provider-policy-verification.md](provider-policy-verification.md): 99/99,
two files, 2.14 seconds, guard exit 0, no limit diagnostic. This verifies pure
policy decisions only; it does not establish persisted budget enforcement or
actual provider access.

DeepSeek adapter evidence is recorded in
[deepseek-verification.md](deepseek-verification.md): final focused run 96/96,
two files, 2.33 seconds, guard exit 0, no timeout/resource diagnostic. The initial
67-pass/19-fail result exposed cross-realm byte-view rejection; the final
`node:util` byte check and finite regression fixtures resolved that failure.
This establishes fake-transport adapter behavior, not live credentials, prompt
quality, grounded composition, or workflow-level durable reservation.

D2 focused execution passed 31/31 tests across seven files in 8.15 seconds
(tool wall time 9.79 seconds), guard exit 0, with no timeout/memory/process-limit
diagnostic. The executed files were policy, schedule, validation,
schedule-temporal, schedule-numeric, schedule-policy-rules and schedule-scope.
Inputs are synthetic; this does not verify actual opening hours or route facts.
Independent D2 additions, D1 compatibility, Typed Commands and repository
integration remain open. Repository command-owned Brief atomicity and trusted
Run-input recovery are being completed against the clarified design 0005.

The first independent D2 plus D1/canonical regression executed 102 tests in five
files: 98 passed and four failed, guard exit 1, Vitest 5.98 seconds (guarded wall
time 7.66 seconds), without resource-limit diagnostics. Three independent
fixtures/assertions did not reach their intended semantic checks; one older
Evidence fixture failed canonical-v2 shape admission before its closure check.
These tests require fixture correction and a fresh guarded run; this result
does not close the compatibility gate. Details are in
[d2-verification.md](d2-verification.md).

The next six-file run included composition: 155/156 passed in 7.16 seconds
(guarded wall time 8.79 seconds), exit 1, without resource-limit diagnostics.
Composition passed its complete focused file; the remaining failure was a D2
test expecting schema rejection for a valid-shaped but arithmetically incorrect
Visit. See [composition-verification.md](composition-verification.md).
The D3 integration decisions now explicitly cover metadata-only unlock,
Visit-specific duration overrides and frozen stay provenance during movement;
their implementation and compatibility regression remain pending.

The corrected baseline subsequently passed all 104 D2/D1/Brief/contracts/
canonical tests, including seven independent D2 cases. In the same guarded run,
repository passed 12/48: 36 tests were stopped by invalid fixture Turn IDs
before their intended transaction paths. Overall result was 116/152, exit 1,
Vitest 9.70 seconds (guarded wall time 11.35 seconds), no resource-limit
diagnostics. Repository fixture correction is assigned to its coder; persistence
acceptance remains open. See [repository-verification.md](repository-verification.md).
The 104-test domain pass is the baseline before the D3 contract additions.

Repository fixture correction subsequently passed the authorized repository-only
run: 48/48, exit 0, Vitest 4.88 seconds (guarded wall time 6.47 seconds), no
resource-limit diagnostics. This closes the focused repository retest, not
HTTP isolation or executor recovery. H1 identity/library integration is released
against this interface; D3 shared-contract regression remains pending.

D3 focused edits/snapshot verification passed 18/18 in two files, exit 0,
Vitest 2.62 seconds (tool wall 4.27 seconds), without resource-limit diagnostics.
See [d3-verification.md](d3-verification.md). Shared-contract compatibility and
the full runtime mutation path remain unverified.

The D3 compatibility run subsequently passed all 215 tests across seven files
(D2 independent, D1 independent, Brief, contracts, canonical, composition and
repository), exit 0, Vitest 12.56 seconds (guarded wall 14.14 seconds), without
resource-limit diagnostics. See
[d3-compatibility-verification.md](d3-compatibility-verification.md).
This closes that shared-contract regression scope, not full workflow acceptance.
Natural-language interpretation subsequently passed 38/38 focused tests, guard
exit 0, Vitest 1.40 seconds (guarded wall 3.05 seconds). See
[interpretation-verification.md](interpretation-verification.md). This verifies
synthetic dispatch and supplied-context contracts, not live language quality or
durable conversation admission.

H1 identity/library handlers subsequently passed 11/11 focused tests with real
SQLite, guard exit 0, Vitest 702 ms (guarded wall 2.35 seconds), without resource
diagnostics. See [h1-verification.md](h1-verification.md). Actual Next route
wiring, browser cookies and workflow mutation acceptance remain unverified.
C1 durable interpretation reservations are in implementation; C2 conversation
dispatch and full executor integration remain pending.

## Completion Rule

Replace each pending entry with dated command/manual evidence against the actual
release source, not design coverage or a worker's intent. Preserve partial and
blocked scopes explicitly. Do not declare delivery complete until every required
scope, startup path, documentation artifact and Git package is verified.
