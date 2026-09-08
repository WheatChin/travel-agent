# Provider Policy Core Verification

Date: 2026-09-08

Status: `pass`

## Scope

Prepared bounded independent tests for the pure provider execution-policy core
approved in `docs/design/0007-provider-execution-policy.md`. The public seams are
budget creation/reservation, retry decisions, and new-planning fact freshness.

Static inspection confirms `src/server/providers/policy.ts` performs no network,
filesystem, database, provider, timer, sleep, or other I/O. It returns proposals
and decisions from caller-supplied state and time. Test tables and loops have
small fixed bounds; the largest new loop records eight attempts.

## Prepared Coverage

- cumulative model-call and requested-token accounting after JSON round-trip,
  including allowances consumed by recovered invalid output;
- rejection when an operation ID is rebound to another operation kind or
  research round;
- two logical repair operations with two transport attempts each, consuming four
  model-call/token entries while consuming only two logical repair slots;
- one supplementary research round without resetting the four-search ceiling;
- terminal retry reasons for exhausted attempts, long Retry-After, permanent
  failures, schema-invalid/refusal/empty/incomplete output, and malformed input;
- missing/future retrieval, conflicting or inapplicable evidence, plus inclusive
  24-hour boundaries for opening windows, closure dates, latest entry,
  reservation requirements, entry conditions, and accessibility.

## Execution

Main confirmed the coder handoff and granted exclusive ownership for one focused
guarded run. Static preflight confirmed fixed finite loops, no network producers,
unique logical repair-operation counting, and the explicit 24-hour fact kinds.

```powershell
$nodePath = (Get-Command node.exe).Source
$vitestPath = (Resolve-Path 'node_modules\vitest\vitest.mjs').Path
& '.\scripts\run-guarded.ps1' -Executable $nodePath -ArgumentList @($vitestPath,'run','tests/provider-policy.test.ts','tests/provider-policy-verification.test.ts','--maxWorkers=1','--no-file-parallelism') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Observed result:

- Guard/process exit: 0
- Test files: 2 passed, 2 total
- Tests: 99 passed, 99 total
- Vitest duration: 2.14 seconds
- Timeout or resource-limit diagnostic: none

The existing non-failing Vite warning about future native config loading was
emitted. Vitest also noted two isolated worker startups and suggested optional
performance tuning; worker count remained within the guard's eight-process cap.

No automatic retry, limit increase, build, typecheck, browser, other suite,
network, installation, live provider, or legacy launcher ran. Execution ownership
was returned to the main thread after this command completed.

## Claim Boundary

Passing this pure policy suite would not prove durable reservation-before-call,
atomic ownership/version checks, crash recovery, paid-call limits, live provider
capabilities, source entailment, workflow integration, latency, cost, or
operational readiness. Those require repository/workflow integration and
separately authorized fake/live evidence.
