# Bounded Local Execution

Status: Approved safety remediation. Finite independent acceptance passed on
2026-09-08; see `../reviews/guarded-runner-verification.md`. Business edits and
main-authorized focused tests may resume under this runner. Builds, browsers,
and legacy startup/verification scripts require separate execution-path review
and authorization. No memory-exhaustion reproduction.

## Scope And Interface

Implement `scripts/run-guarded.ps1` and `scripts/GuardedProcess.cs` for Windows
PowerShell 7 on this host. No dependency installation. The PowerShell entry
compiles the small local C# interop file with Add-Type and calls its entry point.
Target commands are direct executable plus argument array, never a generated
shell command. Resolve executable and working directory before spawning.

Parameters: `-Executable`, `-ArgumentList`, `-WorkingDirectory` (project root
default), `-TimeoutSeconds` (default 120, range 1-600), `-MemoryLimitMB` (default
1536, range 64-4096), `-MaxProcesses` (default 8, range 1-16).
No unlimited mode, detached mode, retries or automatic limit increases.
For Node, call node.exe with a resolved local CLI file, not npm.cmd or npx.

Return the child's exit code normally. Timeout returns 124; guard setup failure
125; detected resource violation 126. Never reinterpret a nonzero result as
success. Fixed diagnostics identify only the reason and measured usage, never
the full command, environment or credentials. Preserve normal child output
without accumulating it in an unbounded string in the parent.

## Native Enforcement

Use a Windows Job Object with JOB_OBJECT_LIMIT_JOB_MEMORY,
JOB_OBJECT_LIMIT_ACTIVE_PROCESS and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
These limit job-wide committed memory and active child processes; they are not
a system-wide memory guarantee or a cap on every kind of kernel/shared memory.
Do not enable either breakaway flag.

Create the target with CreateProcessW, explicit application path, correctly
quoted Windows argv, CREATE_SUSPENDED and CREATE_NO_WINDOW. Configure the Job,
assign the suspended process successfully, then resume its primary thread.
If any step fails, terminate the owned suspended process and close every handle;
never run an unguarded fallback. Descendants launched normally inherit the Job.
Handle nested-job denial as setup failure, not a reason to remove limits.

Wait using a wall-clock deadline. At timeout terminate the whole owned Job.
On normal root exit, close the Job to stop leftover descendants. Use try/finally
for all handles; a noninheritable Job handle plus kill-on-close also protects
against normal guard process termination. Do not enumerate and kill by image
name, PID alone, project-name match or user-wide process ancestry.

Use QueryInformationJobObject for peak committed memory and accounting as
needed. Memory allocation failure may surface as the child's own nonzero exit,
not necessarily a separate notification. Do not claim a missing notification
means no breach. A time limit still bounds a child that handles allocation
failure by continuing to run.

At entry acquire a named per-project mutex without waiting. A concurrent guard
fails safely. Release in finally. Check available physical memory before spawn:
require at least the selected cap plus 2048 MiB free. This is a conservative
preflight only, not a reservation against other applications.

## Verification Before Business Commands

Tester first statically checks lifecycle, structure layouts and quoting.
Then authorize only tiny bounded fixtures through the guard, one at a time:

1. Child returns 0, and separately 7; caller preserves both.
2. Argument containing spaces, quotes and trailing backslashes survives.
3. Finite sleeping child exceeds a 1-second deadline; no child survives.
4. Child starts a finite sleeping descendant; root exit cleans it up.
5. Two guarded commands overlap; second fails the mutex check.
6. Small native fixture requests a single 128 MiB commit under a 64 MiB Job cap;
   allocation is refused and exits with an expected marker/code. Do not use a
   growing loop or require V8 to initialize under this tiny cap.

All fixtures must have their own finite lifetime and allocation bounds if the
guard is broken. Test logs and handles must prove cleanup; a timeout message
alone is insufficient. No whole-tree build/browser run during guard acceptance.
Use `tests/guarded-runner/` for bounded fixtures and
`docs/reviews/guarded-runner-verification.md` for observed evidence.

After approval, one focused Vitest suite may run through the guard with
`--maxWorkers=1 --no-file-parallelism`. Typecheck, builds and browser suites
require separate main-thread execution ownership and retain the guard.

## Primary References

- Microsoft Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Limit flags and memory semantics: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
- Assignment and pre-assignment memory caveat: https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
- Suspended process creation: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw

Initial web-tool fetch attempts returned no readable output. A subsequent
bounded HttpClient read inspected the limit-flags page above and these pages:

- Extended startup structure and required cb size:
  https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-startupinfoexa
- Explicit inherited-handle list requirements:
  https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute

The inspected passages confirm job-wide committed-memory denial, kill on last
Job handle close, sizeof(STARTUPINFOEX) for cb, and inheritable non-pseudo handles
with bInheritHandles TRUE for an explicit handle list. Other reference passages
still require inspection as needed. This document is not execution evidence.
