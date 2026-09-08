[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [string[]] $ArgumentList = @(),

    [string] $WorkingDirectory,

    [ValidateRange(1, 600)]
    [int] $TimeoutSeconds = 120,

    [ValidateRange(64, 4096)]
    [int] $MemoryLimitMB = 1536,

    [ValidateRange(1, 16)]
    [int] $MaxProcesses = 8
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.DirectoryInfo]::new(
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
).FullName

try {
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $resolvedWorkingDirectory = $projectRoot
    }
    else {
        $workingDirectoryItem = Get-Item -LiteralPath $WorkingDirectory -ErrorAction Stop
        if (-not $workingDirectoryItem.PSIsContainer) {
            throw 'Working directory is not a directory.'
        }
        $resolvedWorkingDirectory = $workingDirectoryItem.FullName
    }

    if ([System.IO.Path]::IsPathFullyQualified($Executable) -or
        $Executable.Contains([System.IO.Path]::DirectorySeparatorChar) -or
        $Executable.Contains([System.IO.Path]::AltDirectorySeparatorChar)) {
        $executableItem = Get-Item -LiteralPath $Executable -ErrorAction Stop
        if ($executableItem.PSIsContainer) {
            throw 'Executable path is a directory.'
        }
        $resolvedExecutable = $executableItem.FullName
    }
    else {
        $command = Get-Command -Name $Executable -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $resolvedExecutable = $command.Source
    }

    $interopPath = Join-Path $PSScriptRoot 'GuardedProcess.cs'
    if (-not ('TravelAgent.GuardedProcess' -as [type])) {
        Add-Type -Path $interopPath -ErrorAction Stop
    }

    $exitCode = [TravelAgent.GuardedProcess]::Run(
        $resolvedExecutable,
        [string[]] $ArgumentList,
        $resolvedWorkingDirectory,
        $projectRoot,
        $TimeoutSeconds,
        $MemoryLimitMB,
        $MaxProcesses
    )
}
catch {
    [Console]::Error.WriteLine('guard setup failed')
    exit 125
}

exit $exitCode
