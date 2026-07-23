$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LocationCommand = "Set-Location -LiteralPath '$ProjectRoot'"
$Arguments = @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $LocationCommand
)

Start-Process `
    -FilePath "powershell.exe" `
    -Verb RunAs `
    -WorkingDirectory $ProjectRoot `
    -ArgumentList $Arguments
