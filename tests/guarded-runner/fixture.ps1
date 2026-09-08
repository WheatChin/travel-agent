[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Exit', 'Argv', 'Sleep', 'Descendant')]
    [string] $Mode,

    [int] $ExitCode = 0,
    [ValidateRange(0, 15)]
    [int] $SleepSeconds = 0,
    [string] $EvidencePath,
    [Parameter(ValueFromRemainingArguments)]
    [string[]] $RemainingArguments
)

$ErrorActionPreference = 'Stop'

switch ($Mode) {
    'Exit' {
        exit $ExitCode
    }
    'Argv' {
        [System.IO.File]::WriteAllText(
            $EvidencePath,
            ($RemainingArguments | ConvertTo-Json -Compress),
            [System.Text.UTF8Encoding]::new($false)
        )
        exit 0
    }
    'Sleep' {
        if ($EvidencePath) {
            [System.IO.File]::WriteAllText($EvidencePath, [string] $PID, [System.Text.Encoding]::ASCII)
        }
        Start-Sleep -Seconds $SleepSeconds
        exit 0
    }
    'Descendant' {
        $survivalMarker = "$EvidencePath.survived"
        $childScript = @"
Start-Sleep -Seconds $SleepSeconds
[System.IO.File]::WriteAllText('$($survivalMarker.Replace("'", "''"))', 'SURVIVED', [System.Text.Encoding]::ASCII)
"@
        $encodedChildScript = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($childScript))
        $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedChildScript
        ) -WindowStyle Hidden -PassThru
        [System.IO.File]::WriteAllText(
            $EvidencePath,
            [string] $child.Id,
            [System.Text.Encoding]::ASCII
        )
        Start-Sleep -Seconds 1
        exit 0
    }
}
