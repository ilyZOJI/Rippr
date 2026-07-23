[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$KeepWorking,
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $ProjectRoot "dist\windows"
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    $exitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $exitCode -and $exitCode -ne 0) {
        throw "$Command exited with code $exitCode."
    }
}

$pnpm = (Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue).Source
if (!$pnpm) {
    throw "pnpm.cmd is required to build the Premiere plugin."
}
if (!(Test-Path -LiteralPath "C:\Windows\System32\iexpress.exe")) {
    throw "IExpress is required to create the Windows EXE installer."
}

$stage = Join-Path $env:TEMP ("Rippr-Windows-Installer-" + [guid]::NewGuid().ToString("N"))
$payloadRoot = Join-Path $stage "payload"
$sourceRoot = Join-Path $stage "source"
$payloadZip = Join-Path $sourceRoot "rippr-payload.zip"
$installScript = Join-Path $sourceRoot "Install-Rippr.ps1"
$uninstallScript = Join-Path $sourceRoot "uninstall-rippr.ps1"
$uninstallCmd = Join-Path $sourceRoot "uninstall-rippr.cmd"
$noticesFile = Join-Path $sourceRoot "THIRD-PARTY-NOTICES.txt"
$sedPath = Join-Path $stage "Rippr-Setup.sed"
$outputPath = Join-Path $OutputDirectory "Rippr-Setup-1.0.0.exe"

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot, $sourceRoot, $OutputDirectory | Out-Null
    if (!$SkipBuild) {
        Write-Host "==> Building the plugin" -ForegroundColor Cyan
        Invoke-Checked $pnpm @("build:plugin")
        Write-Host "==> Building the release helper" -ForegroundColor Cyan
        Invoke-Checked "cargo" @("build", "--manifest-path", "helper/Cargo.toml", "--release")
    }

    if (!(Test-Path -LiteralPath "plugin\dist\manifest.json")) {
        throw "plugin/dist is missing. Run the plugin build first."
    }
    if (!(Test-Path -LiteralPath "helper\target\release\rippr-helper.exe")) {
        throw "The release helper binary is missing."
    }

    Copy-Item -LiteralPath "plugin\dist" -Destination (Join-Path $payloadRoot "plugin-dist") -Recurse -Force
    Copy-Item -LiteralPath "helper\target\release\rippr-helper.exe" -Destination (Join-Path $payloadRoot "rippr-helper.exe") -Force
    Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $payloadZip -CompressionLevel Optimal -Force
    Copy-Item -LiteralPath "scripts\install-rippr.ps1" -Destination $installScript -Force
    Copy-Item -LiteralPath "scripts\uninstall-rippr.ps1" -Destination $uninstallScript -Force
    Copy-Item -LiteralPath "scripts\uninstall-rippr.cmd" -Destination $uninstallCmd -Force
    Copy-Item -LiteralPath "vendor\THIRD-PARTY-NOTICES.txt" -Destination $noticesFile -Force
    Write-Host "==> Validating the installer payload" -ForegroundColor Cyan
    Invoke-Checked "PowerShell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installScript, "-ValidateOnly")

    $target = [System.IO.Path]::GetFullPath($outputPath)
    $source = [System.IO.Path]::GetFullPath($sourceRoot)
    $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ExtractOnly=0
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=I
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
InstallPrompt=This will install Rippr 1.0.0 for Adobe Premiere Pro. Continue?
DisplayLicense=
FinishMessage=Rippr was prepared. Creative Cloud will finish installing the Premiere plugin.
TargetName=$target
FriendlyName=Rippr 1.0.0 for Premiere Pro
AppLaunched=PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File Install-Rippr.ps1
PostInstallCmd=<None>
FILE0="Install-Rippr.ps1"
FILE1="rippr-payload.zip"
FILE2="THIRD-PARTY-NOTICES.txt"
FILE3="uninstall-rippr.ps1"
FILE4="uninstall-rippr.cmd"
[SourceFiles]
SourceFiles0=$source
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
%FILE4%=
"@
    Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

    Write-Host "==> Creating the EXE installer" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Force
    }
    Invoke-Checked "C:\Windows\System32\iexpress.exe" @("/N", "/Q", "/M", $sedPath)
    $created = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if (Test-Path -LiteralPath $outputPath) {
            $created = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (!$created) {
        throw "IExpress did not create $outputPath"
    }

    Write-Host "`nREADY: $outputPath" -ForegroundColor Green
} finally {
    if (!$KeepWorking -and (Test-Path -LiteralPath $stage)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
