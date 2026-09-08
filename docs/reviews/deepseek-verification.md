# DeepSeek Adapter Independent Verification

Date: 2026-09-08

Status: final frozen implementation `pass`

## Scope

Reviewed `src/server/providers/deepseek.ts` and `tests/deepseek.test.ts` against
`docs/design/0009-deepseek-json-adapter.md`. Prepared additional finite tests in
`tests/deepseek-verification.test.ts`. No test, compilation, build, typecheck,
browser, network, provider, installation, or legacy launcher command was run.

## Static Review

No blocking adapter-contract defect was identified. The adapter:

- requires injected exact origin/model/key configuration and never reads the
  environment or uses an implicit/global transport;
- validates cancellation, task shape, output-token allowance, and the 128 KiB
  serialized-message limit before awaiting durable reservation;
- performs at most one injected fetch after successful reservation, with fixed
  endpoint, JSON mode, disabled thinking/tools, no-store, and redirect rejection;
- applies one bounded deadline across transport and body consumption;
- uses a fixed 1 MiB response buffer and 16,384-read ceiling, cancelling overflow
  or unfinished bodies without awaiting cancellation indefinitely;
- accepts only one stopped assistant choice whose JSON content passes the
  caller-supplied schema, and returns only closed fixed failures;
- contains no retry, sleep, persistence implementation, logging, or raw provider
  error/body return path.

Existing timeout transports and streams are finite. Delayed fake transports
resolve after 100 ms under fake time. The empty-chunk producer closes after
16,386 pulls, and the overflow producer closes after three bounded chunks. No
unsettled Promise or unlimited stream is used to prove timeout behavior.

## Independent Additions

The new verifier adds non-duplicative cases for:

- explicit assistant `refusal` while finish reason is otherwise `stop`;
- legacy `function_call` rejection and secret redaction;
- omission of optional usage when prompt/completion totals are inconsistent;
- a transport that ignores abort but resolves after 20 ms with a finite closed
  body, proving that the late body is cancelled after the five-millisecond
  adapter deadline.

All fake timers are advanced to finite completion and restored after each test.

### Retry-After Integration Matrix

Design 0009 requires normalized retry hints on HTTP failures. After the frozen
coder handoff, the independent test binds to the stable public
`{ delayMs } | "rate_limited" | "not_retryable"` hint type and verifies:

- numeric `Retry-After: 2` producing an allowed 2000 ms hint from injected time;
- an IMF-fixdate ten seconds after the injected clock producing 10000 ms;
- a delay over 30 seconds producing terminal `rate_limited` rather than clamping;
- malformed or unsupported header text using design 0007's one-second fallback;
- non-retryable HTTP status producing terminal `not_retryable`;
- malformed injected epoch time failing input admission before reservation and
  transport;
- exactly one fetch in every HTTP-failure case and no adapter retry or sleep;
- absence of the raw `Retry-After` value and all other response headers from the
  returned failure.

Every response is a finite in-memory `Response`; these cases require no
stream producer, real timer, network access, or unresolved Promise.

## Claim Boundary

A future fake-transport pass will verify only this adapter boundary. It will not
prove actual credential access, live DeepSeek capability or model quality,
Chinese prompt behavior, durable/atomic reservation, workflow retries, accepted
output persistence, paid-call controls, source grounding, latency, cost, or
complete AC-17 behavior.

## Guarded Focused Result

Main granted exclusive ownership for one focused run after the coder froze the
Retry-After handoff. The command was:

```powershell
$nodePath = (Get-Command node.exe).Source
$vitestPath = (Resolve-Path 'node_modules\vitest\vitest.mjs').Path
& '.\scripts\run-guarded.ps1' -Executable $nodePath -ArgumentList @($vitestPath,'run','tests/deepseek.test.ts','tests/deepseek-verification.test.ts','--maxWorkers=1','--no-file-parallelism') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Observed result:

- Guard/process exit: 1
- Test files: 0 passed, 2 failed
- Tests: 67 passed, 19 failed, 86 total
- Coder suite: 58 passed, 16 failed, 74 total
- Independent suite: 9 passed, 3 failed, 12 total
- Vitest duration: 2.42 seconds
- Guard timeout/resource diagnostic: none

All 19 failures expected a successful or specifically classified JSON envelope
but received `malformed_output`. HTTP failure and Retry-After cases passed because
they return before response-body consumption. The common failure is therefore in
the body-consumption/envelope path rather than retry-hint normalization.

Static diagnosis: `src/server/providers/deepseek.ts:197` rejects chunks using
`value instanceof Uint8Array`. That identity check is cross-realm-sensitive; a
valid Web Streams byte chunk created by Node/jsdom can fail it when its
`Uint8Array` constructor belongs to another realm. This is the leading cause
consistent with the observed broad failure, but requires a coder correction and
fresh authorized run to confirm.

Representative reproductions:

- `tests/deepseek.test.ts:56`: expected accepted structured output with usage,
  observed `malformed_output`.
- `tests/deepseek.test.ts:282`: finish reasons expected incomplete/refused/tool
  classifications, all observed `malformed_output` before classification.
- `tests/deepseek-verification.test.ts:101`: refusal and legacy function call
  expected closed specific failures, observed `malformed_output`.
- `tests/deepseek-verification.test.ts:110`: valid content with inconsistent usage
  expected accepted data without usage, observed `malformed_output`.

Per authorization, no retry, limit increase, other suite, build, typecheck,
browser, network, live provider, or legacy launcher ran. Execution ownership was
returned to the main thread after this failed command.

## Corrected Focused Result

The failed result above remains the historical red phase. After the coder froze
the cross-realm byte-view correction, main authorized one guarded rerun of the
same focused files and limits:

```powershell
$nodePath = (Get-Command node.exe).Source
$vitestPath = (Resolve-Path 'node_modules\vitest\vitest.mjs').Path
& '.\scripts\run-guarded.ps1' -Executable $nodePath -ArgumentList @($vitestPath,'run','tests/deepseek.test.ts','tests/deepseek-verification.test.ts','--maxWorkers=1','--no-file-parallelism') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Observed corrected result:

- Guard/process exit: 0
- Test files: 2 passed, 2 total
- Tests: 96 passed, 96 total
- Vitest duration: 2.42 seconds
- Guard timeout/resource diagnostic: none

The corrected adapter accepts a bounded foreign-realm `Uint8Array` subview while
rejecting finite string, array, `ArrayBuffer`, `DataView`, non-byte typed arrays,
clamped arrays, and spoofed-tag values. Rejections cancel on the first pull and
release the stream lock. The independent refusal, legacy function call,
inconsistent usage, finite late response, normalized Retry-After, redaction, and
invalid-clock admission cases also passed.

The existing non-failing Vite module-format warning and isolated-worker
performance note were emitted. No additional retry, suite, build, typecheck,
browser, network, live provider, or legacy launcher ran. Execution ownership was
returned to the main thread after completion.

### Final Handoff After Execution

After the `96/96` run completed, the coder delivered a superseding frozen change:
the intrinsic `%TypedArray%.prototype` tag check was replaced with the standard
Node `node:util` `types.isUint8Array` predicate. The bounded foreign-realm and
non-byte/spoofed-view regressions remain, but this exact final source snapshot has
not been executed. The single rerun authorization was already consumed, so no
additional run was performed.

The original 19 `malformed_output` failures are confirmed resolved for the prior
intrinsic-getter correction. They are not yet runtime-confirmed against the final
`node:util` implementation, despite the narrow static equivalence of intent.

Main subsequently granted one focused rerun against the final frozen
`node:util types.isUint8Array` implementation. The same guarded command completed
with exit 0: 2 of 2 files and 96 of 96 tests passed in 2.33 seconds, with no guard
timeout or resource diagnostic. This confirms that the original 19
`malformed_output` failures are resolved on the final implementation itself.

Only the existing non-failing Vite module-format warning and isolated-worker
performance note appeared. No additional suite, safety test, build, typecheck,
browser, network, live provider, or legacy launcher ran. Execution ownership was
returned to the main thread after the final command.
