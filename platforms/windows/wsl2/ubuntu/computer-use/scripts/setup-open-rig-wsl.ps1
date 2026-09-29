[CmdletBinding()]
param(
    [ValidateSet("Verify", "Apply")]
    [string]$Mode = "Verify",
    [string]$Distribution = "Ubuntu"
)

$ErrorActionPreference = "Stop"
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
    throw "wsl.exe is not available. Install the current Microsoft Store WSL package first."
}

function Invoke-WslCommand {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & $wsl.Source @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "wsl.exe $($Arguments -join ' ') failed: $($output -join ' ')"
    }
    return @($output | ForEach-Object { "$_" -replace "`0", "" })
}

$version = Invoke-WslCommand -Arguments @("--version")
$distributions = @(Invoke-WslCommand -Arguments @("--list", "--quiet") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($distributions -notcontains $Distribution) {
    throw "WSL distribution '$Distribution' is not installed."
}

$distributionPattern = [regex]::Escape($Distribution)
$details = @(Invoke-WslCommand -Arguments @("--list", "--verbose") | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ })
$matching = @($details | Where-Object { $_ -match "^\s*\*?\s*$distributionPattern\s+" })
$wsl2 = @($matching | Where-Object { $_ -match "\s2\s*$" })
if (-not $wsl2) {
    throw "WSL distribution '$Distribution' is not configured as WSL2."
}

$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $pwsh -and -not $windowsPowerShell) {
    throw "Neither PowerShell 7 nor Windows PowerShell is available."
}

[pscustomobject]@{
    Mode = $Mode
    Distribution = $Distribution
    WslVersion = ($version -join " ")
    PowerShell7 = if ($pwsh) { $pwsh.Source } else { $null }
    WindowsPowerShell = if ($windowsPowerShell) { $windowsPowerShell.Source } else { $null }
    Changed = $false
} | ConvertTo-Json -Depth 3

if ($Mode -eq "Apply") {
    Write-Warning "Apply performs no automatic Windows, systemd, firewall, proxy, or security changes. Complete those prerequisites explicitly, then run the Linux setup script inside WSL."
}
