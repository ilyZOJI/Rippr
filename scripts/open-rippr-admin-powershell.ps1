$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$TestScript = Join-Path $ProjectRoot "scripts\test-rippr.ps1"
$Arguments = @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $TestScript
)

Start-Process `
    -FilePath "powershell.exe" `
    -Verb RunAs `
    -WorkingDirectory $ProjectRoot `
    -ArgumentList $Arguments
