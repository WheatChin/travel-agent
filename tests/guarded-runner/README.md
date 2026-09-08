# Guarded Runner Acceptance Fixtures

These fixtures cover the acceptance cases in design 0008. They are deliberately
finite if the guard fails: sleeps are at most 10 seconds, and the native fixture
makes one 128 MiB allocation request, touches one byte, waits at most two seconds,
then releases it. There are no allocation or process-growth loops.

`verify.ps1` must not be run until the main thread grants guarded-runner acceptance
execution ownership. `-Case exit|argv|timeout|descendant|mutex|native|all` permits
stepwise authorization; `all` is the default but is not initial-run authorization.
The required evidence path must not exist, preventing stale evidence reuse. The
native case compiles only `NativeAllocationFixture.cs` through the guard. Cases
run one at a time except for the required mutex overlap, and write bounded
stdout, stderr, PID, argv, and PASS evidence beneath its required
`-EvidenceDirectory`.

The memory case accepts guard exit 126 or child exit 42 only when captured child
output contains the explicit `ALLOCATION_DENIED` marker. Exit 126 by itself proves
guard enforcement, not that the allocation was refused, and therefore fails this
harness.

The harness adds a 15-second outer deadline to each guard process. On expiry it
terminates only the process tree represented by the process handle it created.
The acceptance result still depends on inspecting the guard's own Job Object
lifecycle and diagnostics; the outer deadline is a verification fail-safe, not
evidence that Job cleanup worked.
