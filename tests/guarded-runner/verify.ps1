param(
    [Parameter(Mandatory)][string] $EvidenceDirectory,
    [ValidateSet('exit', 'argv', 'timeout', 'descendant', 'mutex', 'native', 'all')]
    [string] $Case = 'all'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$guard = Join-Path $projectRoot 'scripts/run-guarded.ps1'
$fixture = Join-Path $PSScriptRoot 'fixture.ps1'
$nativeSource = Join-Path $PSScriptRoot 'NativeAllocationFixture.cs'
$nativeExe = Join-Path $EvidenceDirectory 'NativeAllocationFixture.exe'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$pwsh = (Get-Process -Id $PID).Path

if (Test-Path -LiteralPath $EvidenceDirectory) {
    throw 'EvidenceDirectory must not already exist. Supply a fresh path for each run.'
}
[System.IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null

function Start-GuardProcess {
    param(
        [Parameter(Mandatory)][string] $Executable,
        [string[]] $TargetArguments = @(),
        [Parameter(Mandatory)][string] $Name,
        [int] $TimeoutSeconds = 5,
        [int] $MemoryLimitMB = 256,
        [int] $MaxProcesses = 4
    )

    $payload = @{
        Guard = $guard; Executable = $Executable; TargetArguments = $TargetArguments
        WorkingDirectory = $projectRoot; TimeoutSeconds = $TimeoutSeconds
        MemoryLimitMB = $MemoryLimitMB; MaxProcesses = $MaxProcesses
    } | ConvertTo-Json -Compress
    $launcher = @'
$p = '__PAYLOAD__' | ConvertFrom-Json
& $p.Guard -Executable $p.Executable -ArgumentList @($p.TargetArguments) -WorkingDirectory $p.WorkingDirectory -TimeoutSeconds $p.TimeoutSeconds -MemoryLimitMB $p.MemoryLimitMB -MaxProcesses $p.MaxProcesses
exit $LASTEXITCODE
'@.Replace('__PAYLOAD__', $payload.Replace("'", "''"))
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($launcher))
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwsh
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($item in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)) {
        [void] $startInfo.ArgumentList.Add($item)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void] $process.Start()
    return $process
}

function Stop-OwnedProcess {
    param([System.Diagnostics.Process] $Process, [string] $Name)
    if ($Process.HasExited) { return }
    $Process.Kill($true)
    if (-not $Process.WaitForExit(2000)) {
        throw "Owned process '$Name' did not exit within two seconds after termination."
    }
}

function Complete-GuardProcess {
    param([System.Diagnostics.Process] $Process, [string] $Name, [int] $OuterTimeoutSeconds = 15)
    try {
        $stdoutTask = $Process.StandardOutput.ReadToEndAsync()
        $stderrTask = $Process.StandardError.ReadToEndAsync()
        if (-not $Process.WaitForExit($OuterTimeoutSeconds * 1000)) {
            Stop-OwnedProcess $Process $Name
            throw "Guard invocation '$Name' exceeded its outer verification deadline."
        }
        $outputTasks = [System.Threading.Tasks.Task]::WhenAll($stdoutTask, $stderrTask)
        if (-not $outputTasks.Wait(2000)) {
            throw "Guard invocation '$Name' output did not close within two seconds."
        }
        [System.IO.File]::WriteAllText((Join-Path $EvidenceDirectory "$Name.stdout.txt"), $stdoutTask.Result)
        [System.IO.File]::WriteAllText((Join-Path $EvidenceDirectory "$Name.stderr.txt"), $stderrTask.Result)
        return $Process.ExitCode
    }
    finally { $Process.Dispose() }
}

function Invoke-BoundedGuard {
    param([string] $Executable, [string[]] $TargetArguments = @(), [string] $Name,
          [int] $TimeoutSeconds = 5, [int] $MemoryLimitMB = 256, [int] $MaxProcesses = 4)
    $process = Start-GuardProcess @PSBoundParameters
    Complete-GuardProcess -Process $process -Name $Name
}

function Wait-ForPidHandle([string] $Path, [string] $Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            $parsedPid = 0
            if ([int]::TryParse((Get-Content -Raw -LiteralPath $Path), [ref] $parsedPid)) {
                try {
                    $process = [System.Diagnostics.Process]::GetProcessById($parsedPid)
                    [void] $process.Handle
                    return $process
                }
                catch [System.ArgumentException] { }
            }
        }
        Start-Sleep -Milliseconds 25
    }
    throw "$Label did not publish a live process handle."
}

function Assert-Equal($Expected, $Actual, [string] $Label) {
    if ($Expected -ne $Actual) { throw "$Label expected '$Expected' but observed '$Actual'." }
}

function Includes-Case([string] $Name) { return $Case -eq 'all' -or $Case -eq $Name }

$prefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $fixture)

if (Includes-Case 'exit') {
    Assert-Equal 0 (Invoke-BoundedGuard $pwsh ($prefix + @('-Mode','Exit','-ExitCode','0')) 'exit-0') 'exit-0'
    Assert-Equal 7 (Invoke-BoundedGuard $pwsh ($prefix + @('-Mode','Exit','-ExitCode','7')) 'exit-7') 'exit-7'
}

if (Includes-Case 'argv') {
    $argvPath = Join-Path $EvidenceDirectory 'argv.json'
    $expectedArgv = @('two words', 'say "hello"', 'C:\path with spaces\\')
    Assert-Equal 0 (Invoke-BoundedGuard $pwsh ($prefix + @('-Mode','Argv','-EvidencePath',$argvPath) + $expectedArgv) 'argv') 'argv exit'
    Assert-Equal ($expectedArgv | ConvertTo-Json -Compress) (@(Get-Content -Raw $argvPath | ConvertFrom-Json) | ConvertTo-Json -Compress) 'argv payload'
}

if (Includes-Case 'timeout') {
    $timeoutPid = Join-Path $EvidenceDirectory 'timeout.pid'
    $timeoutProcess = Start-GuardProcess $pwsh ($prefix + @('-Mode','Sleep','-SleepSeconds','3','-EvidencePath',$timeoutPid)) 'timeout' 1
    $timeoutChild = $null
    try {
        $timeoutChild = Wait-ForPidHandle $timeoutPid 'timeout fixture'
        Assert-Equal 124 (Complete-GuardProcess $timeoutProcess 'timeout') 'timeout exit'
        $timeoutProcess = $null
        if (-not $timeoutChild.WaitForExit(1000)) { throw 'Timeout child survived Job termination.' }
    }
    finally {
        if ($null -ne $timeoutProcess) { Stop-OwnedProcess $timeoutProcess 'timeout'; $timeoutProcess.Dispose() }
        if ($null -ne $timeoutChild) { $timeoutChild.Dispose() }
    }
}

if (Includes-Case 'descendant') {
    $descendantPid = Join-Path $EvidenceDirectory 'descendant.pid'
    $descendantProcess = Start-GuardProcess $pwsh ($prefix + @('-Mode','Descendant','-SleepSeconds','3','-EvidencePath',$descendantPid)) 'descendant'
    $descendantChild = $null
    try {
        $descendantChild = Wait-ForPidHandle $descendantPid 'descendant fixture'
        Assert-Equal 0 (Complete-GuardProcess $descendantProcess 'descendant') 'descendant root exit'
        $descendantProcess = $null
        if (-not $descendantChild.WaitForExit(1000)) { throw 'Descendant survived Job closure.' }
        Start-Sleep -Seconds 3
        if (Test-Path "$descendantPid.survived") { throw 'Descendant wrote its survival marker.' }
    }
    finally {
        if ($null -ne $descendantProcess) { Stop-OwnedProcess $descendantProcess 'descendant'; $descendantProcess.Dispose() }
        if ($null -ne $descendantChild) { $descendantChild.Dispose() }
    }
}

if (Includes-Case 'mutex') {
    $mutexPid = Join-Path $EvidenceDirectory 'mutex-first.pid'
    $mutexArgs = $prefix + @('-Mode','Sleep','-SleepSeconds','3','-EvidencePath',$mutexPid)
    $first = Start-GuardProcess $pwsh $mutexArgs 'mutex-first'
    $mutexChild = $null
    try {
        $mutexChild = Wait-ForPidHandle $mutexPid 'first mutex fixture'
        Assert-Equal 125 (Invoke-BoundedGuard $pwsh ($prefix + @('-Mode','Exit')) 'mutex-second') 'mutex second exit'
        Assert-Equal 0 (Complete-GuardProcess $first 'mutex-first') 'mutex first exit'
        $first = $null
    }
    finally {
        if ($null -ne $first) { Stop-OwnedProcess $first 'mutex-first'; $first.Dispose() }
        if ($null -ne $mutexChild) { $mutexChild.Dispose() }
    }
}

if (Includes-Case 'native') {
    $compileArgs = @('/nologo', '/target:exe', "/out:$nativeExe", $nativeSource)
    Assert-Equal 0 (Invoke-BoundedGuard $compiler $compileArgs 'compile-native') 'native fixture compilation'
    $nativeExit = Invoke-BoundedGuard $nativeExe @() 'native-memory' 5 64 1
    if ($nativeExit -notin @(42, 126)) { throw "native allocation case returned unexpected exit $nativeExit." }
    Assert-Equal 'ALLOCATION_DENIED' ((Get-Content -Raw (Join-Path $EvidenceDirectory 'native-memory.stdout.txt')).Trim()) 'native allocation marker'
}

[System.IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'PASS'), "guarded-runner $Case acceptance passed`r`n", [System.Text.Encoding]::ASCII)
