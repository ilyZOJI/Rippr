$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Say([string]$Message) {
    Write-Host "`n==> $Message"
}

function Fail([string]$Message) {
    Write-Host "`n[FAILED] $Message" -ForegroundColor Red
    Write-Host "The PowerShell window will stay open so you can read the error."
    Read-Host "Press Enter to close"
    exit 1
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "$Name is not installed or is not on PATH."
    }
}

function Warn-Command([string]$Name, [string]$Message) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "[warning] $Message" -ForegroundColor Yellow
    }
}

function Invoke-Pnpm([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments) {
    & $script:PnpmCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm exited with code $LASTEXITCODE."
    }
}

function Get-WorkspaceHelperProcess([string]$ExecutablePath) {
    $connections = @(Get-NetTCPConnection -LocalPort 43117 -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
            continue
        }

        $runningPath = [System.IO.Path]::GetFullPath($process.ExecutablePath)
        if ($runningPath -ieq $ExecutablePath) {
            Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        }
    }
}

function Stop-WorkspaceHelper([string]$ExecutablePath) {
    $oldProcesses = @(Get-WorkspaceHelperProcess $ExecutablePath)
    foreach ($oldProcess in $oldProcesses) {
        Stop-Process -Id $oldProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($oldProcesses.Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
}

Say "Checking required tools"
Require-Command "pnpm.cmd"
Require-Command "cargo"
Warn-Command "ffmpeg" "ffmpeg is not on PATH; downloads requiring conversion will fail."
Warn-Command "ffprobe" "ffprobe is not on PATH; media probing may fail."
Warn-Command "yt-dlp" "yt-dlp is not on PATH; downloads cannot start."

$script:PnpmCommand = (Get-Command "pnpm.cmd").Source
$helperPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "helper\target\debug\rippr-helper.exe"))

# Windows keeps an executable locked while it is running. Stop only the helper
# built from this workspace before Cargo tries to replace its binary.
Stop-WorkspaceHelper $helperPath

try {
    Say "Running tests and type checks"
    Invoke-Pnpm "test"

    Say "Building the Premiere plugin"
    Invoke-Pnpm "build:plugin"

    Say "Building the native helper"
    & cargo build --manifest-path helper/Cargo.toml
    if ($LASTEXITCODE -ne 0) {
        throw "cargo exited with code $LASTEXITCODE."
    }
} catch {
    Fail $_.Exception.Message
}

if (-not (Test-Path -LiteralPath $helperPath)) {
    Fail "The helper binary was not produced at $helperPath."
}

Say "Restarting the local helper"
$helperLog = Join-Path $ProjectRoot ".rippr-helper.log"
$helperErrorLog = Join-Path $ProjectRoot ".rippr-helper.error.log"
$helperProcess = Start-Process `
    -FilePath $helperPath `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $helperLog `
    -RedirectStandardError $helperErrorLog `
    -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Milliseconds 300
    $listener = @(Get-NetTCPConnection -LocalPort 43117 -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $helperProcess.Id })
    if ($listener.Count -gt 0) {
        $ready = $true
        break
    }
    if ($helperProcess.HasExited) {
        break
    }
}

if (-not $ready) {
    Write-Host "Helper stdout: $helperLog"
    Write-Host "Helper stderr: $helperErrorLog"
    Fail "The helper did not start and listen on port 43117."
}

Write-Host "`nREADY TO TEST" -ForegroundColor Green
Write-Host "Plugin build: $ProjectRoot\plugin\dist"
Write-Host "Helper PID:    $($helperProcess.Id)"
Write-Host "Helper log:    $helperLog"
Write-Host "Helper errors:  $helperErrorLog"
Write-Host "`nReload the Rippr panel in Premiere, then test the change."
Read-Host "Press Enter to close"
