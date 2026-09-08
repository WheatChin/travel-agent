# Guarded Runner Verification

Date: 2026-09-08

Status: static `ready`; guarded-runner acceptance `pass`

## Scope

This review began with static fixture authoring only. Main subsequently granted
exclusive, stepwise execution of the finite guarded-runner acceptance fixtures.
No business test, build, browser, network, installation, or legacy launcher was
authorized or executed.

`scripts/start.ps1` and `scripts/verify.ps1` remain outside this review's write
scope and remain unauthorized. They directly invoke `npm.cmd`/`npx.cmd`, and
can automatically install dependencies. The explicit override in
`docs/agent-workflow.md` applies; guarded-runner acceptance must not invoke them.

The bounded acceptance fixtures are in `tests/guarded-runner/`. They cover child
exit-code preservation for 0 and 7, exact Windows argv transport, timeout,
descendant cleanup after root exit, per-project mutex exclusion, and denial of a
single 128 MiB native allocation under a 64 MiB Job memory cap.

Every fixture is finite without a working guard. The longest child sleep is 10
seconds. The native case performs one fixed allocation request, touches one byte
only if allocation succeeds, waits two seconds, releases it, and exits. The
harness also imposes an external 15-second process-handle deadline on each guard
invocation and writes bounded evidence files.

## Static Review

Preliminary review performed against the current unexecuted runner snapshot.
Earlier blocking findings have visible revisions: `STARTUPINFO.cb` uses the size
of `STARTUPINFOEX`; process creation uses an explicit inherited-handle list;
resource messages terminate the Job; and process waits, message drains, and pump
waits are bounded. Input range and NUL validation is present.

### Final Static Result

No remaining static blocker was identified. The prior output-pump finding is
addressed by checking bounded task completion and returning setup/cleanup failure
instead of the child result on timeout or fault. The prior process-wait finding is
addressed by treating post-termination `WAIT_TIMEOUT` as cleanup failure. Pipe
read ownership is transferred to `SafeFileHandle`; failure cleanup requests
`CancelIoEx` and remains bounded. A worker that cannot be cancelled may retain
its own handle until process exit, but the guard does not report false cleanup
success and the PowerShell wrapper then exits.

PowerShell AST parsing reported no syntax errors for `scripts/run-guarded.ps1`,
`tests/guarded-runner/verify.ps1`, or `tests/guarded-runner/fixture.ps1`. This was
a parse-only check; none of those scripts was invoked.

The static pass covered:

- exact native structure layouts and field widths;
- Windows command-line quoting, including embedded quotes and trailing slashes;
- executable and working-directory resolution before `CreateProcessW`;
- suspended creation, Job configuration, assignment, then resume ordering;
- fail-closed cleanup of the owned suspended process and every native handle;
- Job memory, active-process, and kill-on-close limits with no breakaway flags;
- deadline handling and whole-Job termination through owned handles;
- normal root-exit closure of the Job to remove descendants;
- noninheritable Job handles and `try/finally` lifecycle coverage;
- nonblocking named per-project mutex acquisition and release in `finally`;
- available-memory preflight requiring cap plus 2048 MiB;
- bounded output forwarding and fixed diagnostics without command/environment data;
- exit mappings: child result unchanged, timeout 124, setup failure 125, and
  detected resource violation 126.

## Dynamic Evidence

Exit-code preservation: `pass`.

Command executed under exclusive authorization:

```powershell
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/guarded-runner/verify.ps1 -Case exit -EvidenceDirectory .tmp/guard-verification/exit-20260908-001
```

The harness exited 0. Evidence contained empty stdout/stderr for both finite
children and `PASS` contained `guarded-runner exit acceptance passed`. This
confirms preservation of child exit codes 0 and 7 through the harness assertions.

Argument quoting, timeout cleanup, descendant cleanup, mutex exclusion, and
native memory denial remain `not_run`. No compilation, business test, build, or
browser command was run in this step.

Argument quoting: `fail` at the harness boundary.

Command:

```powershell
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/guarded-runner/verify.ps1 -Case argv -EvidenceDirectory .tmp/guard-verification/argv-20260908-001
```

The harness exited 1 at `tests/guarded-runner/verify.ps1:113`, reporting
`argv exit expected '0' but observed '1'`. Captured stderr shows that the fixture
rejected the `--` token as an ambiguous empty parameter name before writing
`argv.json`. This is a harness invocation defect, not evidence that the runner's
Windows argv quoting changed the payload. Per authorization, verification stopped
at this first failure. Timeout, descendant, mutex, and native cases remain
`not_run`; no native compilation occurred.

### Authorized Sequential Follow-up

Argument quoting: `pass` after the narrow fixture correction.

```powershell
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/guarded-runner/verify.ps1 -Case argv -EvidenceDirectory .tmp/guard-verification/argv-20260908-002
```

Harness exit: 0. `argv.json` contains exactly
`["two words","say \"hello\"","C:\\path with spaces\\\\"]`; stdout and
stderr are empty.

Timeout and child cleanup: `pass`.

```powershell
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/guarded-runner/verify.ps1 -Case timeout -EvidenceDirectory .tmp/guard-verification/timeout-20260908-001
```

Harness exit: 0. The held child process handle observed exit after whole-Job
termination. Captured stderr is `guard timeout after 1 seconds`; PASS evidence
was written.

Descendant cleanup: `fail` before cleanup could be assessed.

```powershell
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/guarded-runner/verify.ps1 -Case descendant -EvidenceDirectory .tmp/guard-verification/descendant-20260908-001
```

Harness exit: 1 at `tests/guarded-runner/verify.ps1:109`, with `descendant fixture
did not publish a live process handle.` No PID or output evidence was produced
within the bounded three-second synchronization interval. The harness cleaned up
its owned guard process tree. This is an inconclusive fixture-start failure, not
a descendant-cleanup pass or proof of a runner cleanup defect.

Execution stopped at the first failure. Mutex and native cases remain `not_run`;
the native fixture was not compiled.

### Direct Descendant Diagnostic

`fail` before guard invocation. The one authorized direct diagnostic attempted a
fresh nested `pwsh.exe -Command`, but the calling shell expanded the nested
`$evidencePath` variable while constructing the command. The resulting explicit
argument array ended with `'-EvidencePath',)` and the fresh process exited 1 with:

```text
ParserError: Missing expression after ','.
```

The guard and fixture did not execute, so this produced no evidence for the
descendant failure hypotheses. Per the authorization, no retry was performed.

The separately authorized corrected diagnostic invoked the guard directly from
PowerShell with the explicit target argument array and unchanged limits:
timeout 5 seconds, memory 256 MiB, and maximum processes 4. It exited 0 with no
stdout or stderr. The fixture published descendant PID `15308`, and the bounded
survival marker was absent after guard completion.

This demonstrates that the direct descendant fixture can start and that normal
root exit closes the Job before the descendant writes its marker. Guard
`Add-Type` startup overhead is the likely explanation for the prior harness
missing its three-second PID readiness interval, but that diagnostic alone did
not prove the cause. The later held-handle case with a ten-second readiness
window provides the acceptance evidence.

### Final Sequential Cases

After the readiness-only harness correction, descendant cleanup passed:

```powershell
& '.\tests\guarded-runner\verify.ps1' -Case descendant -EvidenceDirectory '.tmp\guard-verification\descendant-20260908-002'
```

Harness exit: 0. The descendant PID was acquired as a live process handle before
root exit, that handle observed process exit, stdout/stderr were empty, the
survival marker was absent, and PASS evidence was written.

Mutex exclusion passed:

```powershell
& '.\tests\guarded-runner\verify.ps1' -Case mutex -EvidenceDirectory '.tmp\guard-verification\mutex-20260908-001'
```

Harness exit: 0. The first child was confirmed live before overlap. The second
guard returned 125 with fixed stderr `guard setup failed: another project command
is active`; the first guard subsequently returned 0 and PASS evidence was written.

Native memory denial passed:

```powershell
& '.\tests\guarded-runner\verify.ps1' -Case native -EvidenceDirectory '.tmp\guard-verification\native-20260908-001'
```

Harness exit: 0. Compilation of only the finite native fixture ran through the
guard. The single 128 MiB commit request under a 64 MiB Job cap emitted the child
marker `ALLOCATION_DENIED`; the guard classified the detected resource event as
126 and reported peak Job memory 138 MiB. Both enforcement classification and
allocation-denial evidence were therefore present. Because the reported peak
exceeded the configured 64 MiB cap, this result does not prove a 64 MiB resident-
memory ceiling; Job committed-memory semantics and resident usage are different
measurements. PASS evidence was written for the designed denial behavior only.

All guarded-runner acceptance behaviors in design 0008 have now passed across
the authorized stepwise runs: exit 0/7 preservation, exact argv, timeout and
child cleanup, descendant cleanup, mutex exclusion, and native memory denial.
These tiny fixture results do not authorize or establish safety for unbounded
business commands, builds, browsers, or the existing startup/verification scripts.

The native case requires the explicit `ALLOCATION_DENIED` child marker for both
possible classifications: child exit 42 or guard exit 126. Exit 126 alone is not
accepted as proof that the allocation itself was denied.

## Merge Risk

The guarded runner passed its finite acceptance fixtures. Business execution
remains subject to main-thread ownership, bounded worker settings, and the
separate restrictions on existing startup/verification scripts. Tiny fixture
results do not establish all-workload protection.
