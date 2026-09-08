# Local Resource Exhaustion

Status: Incident confirmed; likely triggering test identified. Finite guard
acceptance passed; explicitly owned, guarded focused tests may resume.
No deliberate reproduction of the machine freeze is permitted.

## Observed Evidence

Read-only Windows event inspection after reboot returned:

| Local time on 2026-09-08 | Evidence |
| --- | --- |
| 01:54:55 | System event 2004: virtual memory exhaustion; node.exe PID 15000 used 48607129600 bytes |
| 01:59:56 | System event 2004: same process used 55837401088 bytes |
| 02:03:43 | System event 41: restart without normal shutdown |

The operating-system query reported 15.7 GiB visible physical memory and
7.2 GiB free after reboot. Reported Node figures above are virtual-memory
consumption, not resident physical memory. The old PID no longer exists.

## Likely Trigger

`tests/http-security.test.ts` generated unlimited 40000-byte chunks in a
ReadableStream pull callback. At that time `src/server/http/security.ts`
called `request.text()` without a streaming size bound.

The HTTP coder reported running the expanded suite, then a timeout and a closed
tool host. Other coders reported out-of-memory/startup failures and closed
stdout while running tests/typechecks. This is strong corroborating evidence,
but the old PID's exact command line was not recovered after reboot.

The test can accumulate unbounded input against the incomplete implementation.
Its safety must not depend on the implementation already being correct, or on
a test timeout interrupting a continually active stream. Concurrent commands
added resource pressure but do not explain away this unbounded producer.

## Containment And Recovery Gate

All four active agents were interrupted, acknowledged the pause, and closed.
No unrelated user processes were killed. No high-load reproduction was run.
The HTTP coder may perform only a finite-stream safety patch, without commands.

Before test/build/browser execution resumes:

1. Replace unlimited input with a finite small stream that still asserts early
   cancellation and 413 on overflow.
2. Statically inspect the patch and other test producers for boundedness.
3. Implement an external bounded command runner: owned process-tree lifecycle,
   wall-clock deadline, resource monitoring and no automatic retry after breach.
4. Verify the runner using tiny controlled child processes, then run one focused
   suite with one worker. Do not start concurrent builds or browser suites.

The runner is not yet implemented or verified. No claim of resolved root cause,
passed regression, or whole-machine memory protection is made by this report.
AGENTS.md now records the execution pause and single-command ownership rule.

Safety patch applied and statically inspected: the overflow case produces at
most three 40000-byte chunks, closes on the third, disables prefetch, and asserts
cancellation within two pulls. Its input is now bounded at 120000 bytes even
when the reader ignores the limit. The suite was not executed. The safety coder
was closed after handoff; no development worker remains authorized to execute.

## Recovery Implementation Review

The initial guard and finite verification fixtures now exist, but have not been
compiled or executed. Main-thread static review returned these blockers to
their respective owners:

- Synchronous pipe handles were wrapped as asynchronous FileStreams.
- Resource-limit notifications set a flag without promptly terminating the Job.
- Cleanup included an infinite wait; completion-message draining was unbounded.
- Child handle inheritance was not restricted to an explicit allowlist.
- Verification used lossy command argument forwarding and insufficient
  process-identity evidence for cleanup.
- The proposed PowerShell compilation path for a console fixture must be
  replaced with a supported compiler invocation. Read-only inventory confirmed
  the local .NET Framework C# compiler exists; it has not been run.

These findings block runtime authorization. The coder and tester may edit their
assigned safety files and perform small read-only inspections only. Startup and
business verification scripts still bypass the guard and remain paused.

## Limited Recovery Authorization

The independent report `guarded-runner-verification.md` now records passes for
exit 0/7, exact argv, timeout/root cleanup, descendant cleanup, mutex exclusion
and a denied single 128 MiB commit request under a configured 64 MiB Job limit.
Main authorizes business file edits and individually assigned focused tests
through the guard with one worker. Builds, browsers and legacy launcher paths
remain separately gated. There is no automatic retry or limit escalation.

The native denial case reported peak Job memory of 138 MiB despite the 64 MiB
configured limit. Allocation denial and the resource event are directly observed;
the peak-counter discrepancy is not explained by this verification. Do not
describe the counter as proof of peak resident memory staying below the limit,
or claim system-wide protection. Retain the finite-input and timeout safeguards.
