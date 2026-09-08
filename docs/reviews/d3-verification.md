# D3 Focused Verification

Date: 2026-09-08

Status: focused tests passed. Recorded by main from the independent tester's
completion handoff; this is not a full workflow or browser acceptance result.

The tester inspected the boundedness of the two test files and shared schedule
fixtures before receiving exclusive execution authorization. The 18 cases were
synchronous, with no streams, timers, servers or unbounded producers.

Executed once through `scripts/run-guarded.ps1`, using resolved `node.exe` and
local `node_modules/vitest/vitest.mjs`, with arguments:

```text
run --maxWorkers=1 --no-file-parallelism tests/edits.test.ts tests/snapshot.test.ts
```

Limits: 120 seconds, 1536 MiB, 8 processes. Observed: 2/2 files and 18/18 tests
passed; process exit 0; Vitest 2.62 seconds, tool wall time 4.27 seconds. No
timeout, memory or process-limit diagnostic. The known Vite configuration
warning and worker startup performance note were non-fatal.

No retry, build, typecheck, browser, network or implementation modification was
performed by the tester. Execution ownership was returned to main.

This verifies the focused edit/snapshot suite only. Compatibility regression
for the D3 shared contract changes, composition additions, repository integration
and complete runtime mutation behavior remain separate gates.
