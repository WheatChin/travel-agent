[CmdletBinding()]
param(
    [switch]$InstallBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue

if (-not $npmCommand -or -not $npxCommand) {
    throw "npm.cmd and npx.cmd are required. Install the Node.js/npm version documented in requirements.md."
}

function Invoke-VerificationStep {
    param(
        [string]$Label,
        [string]$FilePath,
        [string[]]$ArgumentList
    )

    Write-Host "`n==> $Label"
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Verification stopped: '$Label' failed with exit code $LASTEXITCODE."
    }
}

Push-Location $projectRoot
try {
    if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
        Invoke-VerificationStep -Label "Install dependencies" -FilePath $npmCommand.Source -ArgumentList @("ci")
    }

    if ($InstallBrowser) {
        Invoke-VerificationStep -Label "Install Playwright Chromium" -FilePath $npxCommand.Source -ArgumentList @("playwright", "install", "chromium")
    }

    Invoke-VerificationStep -Label "Typecheck" -FilePath $npmCommand.Source -ArgumentList @("run", "typecheck")
    Invoke-VerificationStep -Label "Lint" -FilePath $npmCommand.Source -ArgumentList @("run", "lint")
    Invoke-VerificationStep -Label "Unit tests" -FilePath $npmCommand.Source -ArgumentList @("test")
    Invoke-VerificationStep -Label "Production build" -FilePath $npmCommand.Source -ArgumentList @("run", "build")
    Invoke-VerificationStep -Label "Browser tests" -FilePath $npmCommand.Source -ArgumentList @("run", "test:e2e")

    Write-Host "`nAll verification steps passed."
}
finally {
    Pop-Location
}
