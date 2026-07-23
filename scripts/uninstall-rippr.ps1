[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [switch]$Force,
    [switch]$SkipCreativeCloud
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Rippr"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$rootName = [System.IO.Path]::GetFileName($resolvedRoot)
if (![string]::Equals($rootName, "Rippr", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path that is not a Rippr install directory: $resolvedRoot"
}
if ([string]::IsNullOrWhiteSpace($resolvedRoot) -or $resolvedRoot -eq [System.IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\')) {
    throw "Refusing to remove a filesystem root."
}

if (!(Test-Path -LiteralPath $resolvedRoot)) {
    Write-Host "Rippr is already removed from $resolvedRoot." -ForegroundColor Yellow
    exit 0
}

if (!$Force) {
    Write-Host "This removes Rippr's local package cache, helper, and downloaded tools:" -ForegroundColor Cyan
    Write-Host "  $resolvedRoot"
    Write-Host "It does not remove your downloaded media or Premiere projects."
    $confirmation = Read-Host "Type REMOVE to continue"
    if ($confirmation -cne "REMOVE") {
        Write-Host "Uninstall cancelled." -ForegroundColor Yellow
        exit 0
    }
}

try {
    $rootPrefix = "$resolvedRoot\"
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq "rippr-helper.exe" -and
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($process in $processes) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
} catch {
    Write-Warning "Could not inspect all running helper processes. Continuing with file removal."
}

Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
Write-Host "Rippr's local files were removed." -ForegroundColor Green

if (!$SkipCreativeCloud) {
    Write-Host "Creative Cloud manages the installed Premiere panel separately." -ForegroundColor Cyan
    Write-Host "Remove Rippr from Creative Cloud's installed plugins if it is still listed."
    try {
        Start-Process "https://creativecloud.adobe.com/apps"
    } catch {
        Write-Host "Open https://creativecloud.adobe.com/apps to remove the Premiere panel." -ForegroundColor Yellow
    }
}
