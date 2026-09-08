[CmdletBinding()]
param(
    [ValidateSet("dev", "prod")]
    [string]$Mode = "dev",

    [Alias("Host")]
    [string]$HostName = "127.0.0.1",

    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Resolve-ListenAddress {
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Host must not be empty."
    }

    $parsedAddress = $null
    if ([System.Net.IPAddress]::TryParse($Name, [ref]$parsedAddress)) {
        return $parsedAddress
    }

    if ($Name -ne "localhost") {
        throw "Host must be localhost or a numeric IP address. Received: $Name"
    }

    return [System.Net.IPAddress]::Loopback
}

function Assert-PortAvailable {
    param(
        [System.Net.IPAddress]$Address,
        [int]$ListenPort
    )

    $listener = [System.Net.Sockets.TcpListener]::new($Address, $ListenPort)
    try {
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
    }
    catch {
        throw "Port $ListenPort is already occupied on $HostName. Choose another port with -Port."
    }
    finally {
        $listener.Stop()
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$listenAddress = Resolve-ListenAddress -Name $HostName
$displayHost = if ($listenAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { "[$HostName]" } else { $HostName }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    throw "npm.cmd was not found. Install the Node.js/npm version documented in requirements.md."
}

Assert-PortAvailable -Address $listenAddress -ListenPort $Port

Push-Location $projectRoot
try {
    if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
        Write-Host "Dependencies are missing; running npm ci..."
        Invoke-CheckedCommand -FilePath $npmCommand.Source -ArgumentList @("ci")
    }

    if ($Mode -eq "prod") {
        Write-Host "Building the production application..."
        Invoke-CheckedCommand -FilePath $npmCommand.Source -ArgumentList @("run", "build")
    }

    $scriptName = if ($Mode -eq "prod") { "start" } else { "dev" }
    $url = "http://${displayHost}:$Port"
    Write-Host "Starting Travel Agent in $Mode mode at $url"
    Write-Host "Press Ctrl+C to stop."
    Invoke-CheckedCommand -FilePath $npmCommand.Source -ArgumentList @("run", $scriptName, "--", "--hostname", $HostName, "--port", $Port.ToString())
}
finally {
    Pop-Location
}
