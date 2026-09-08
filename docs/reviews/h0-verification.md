# H0 HTTP Boundary Verification

Date: 2026-09-08

Status: `pass`

## Scope

Verified the approved H0 slice in `docs/design/0006-http-workflow-integration.md`:
`src/server/http/security.ts` and `tests/http-security.test.ts`. No route,
repository, provider, workflow, build, typecheck, browser, or other test suite was
executed.

## Static Review

No blocking contract defect was identified. The implementation:

- validates configured and request origins and rejects cross-site Fetch Metadata;
- accepts only JSON with an optional UTF-8 charset and identity encoding;
- accumulates at most 65,536 actual bytes in one fixed buffer and requests reader
  cancellation on overflow;
- rejects malformed UTF-8/JSON, non-object roots, and nested forged Owner fields
  with iterative traversal;
- distinguishes absent credentials from invalid or duplicate fixed-format cookies;
- serializes a host-only hardened cookie after credential and date validation;
- maps expected errors through fixed status/messages and redacts unknown errors.

The test producers are finite. Streamed overflow produces no more than 120,000
bytes, and the deep ownership cases are finite JSON values.

## Execution

Exclusive execution ownership was granted for one focused Vitest invocation.
The resolved executable was `C:\Program Files\nodejs\node.exe`; the resolved CLI
was the local `node_modules/vitest/vitest.mjs`.

```powershell
$nodePath = (Get-Command node.exe).Source
$vitestPath = (Resolve-Path 'node_modules\vitest\vitest.mjs').Path
& '.\scripts\run-guarded.ps1' -Executable $nodePath -ArgumentList @($vitestPath,'run','tests/http-security.test.ts','--maxWorkers=1','--no-file-parallelism') -WorkingDirectory $PWD.Path -TimeoutSeconds 120 -MemoryLimitMB 1536 -MaxProcesses 8
```

Observed result:

- Guard/process exit: 0
- Test files: 1 passed, 1 total
- Tests: 53 passed, 53 total
- Vitest duration: 27.50 seconds
- Resource-limit or timeout diagnostic: none

Vite emitted a non-failing warning that `vitest.config.ts` uses ESM syntax while
loaded as CommonJS under the future `configLoader: native` behavior. This does not
change the H0 result but remains configuration maintenance risk.

## Remaining Risk

H0 helpers do not authorize resources or apply strict domain schemas; callers
must perform those checks. Browser acceptance of Secure loopback cookies and
two-Owner authorization remain later integration coverage by design. This focused
pass is not evidence for other suites, builds, browsers, or legacy launchers.

Execution ownership was returned to the main thread after this command completed.
