[CmdletBinding()]
param(
    [switch]$SkipLaunch,
    [switch]$KeepWorking,
    [switch]$ValidateOnly,
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = "1.0.0"
$YtDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
$YtDlpLicenseUrl = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/LICENSE"
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Rippr"
}

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Download-File([string]$Uri, [string]$Destination) {
    Write-Host "Downloading $Uri" -ForegroundColor DarkGray
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
    if (!(Test-Path -LiteralPath $Destination) -or (Get-Item -LiteralPath $Destination).Length -lt 1024) {
        throw "The download did not produce a valid file: $Uri"
    }
}

function Find-RequiredBinary([string]$Root, [string]$Name) {
    $binary = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $binary) {
        throw "The FFmpeg archive did not contain $Name."
    }
    return $binary.FullName
}

function Get-ToolVersion([string]$Path, [string[]]$Arguments) {
    $output = @(& $Path @Arguments 2>&1)
    $exitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $exitCode -and $exitCode -ne 0) {
        throw "The downloaded tool failed its version check: $Path"
    }
    return ($output | Select-Object -First 1).ToString().Trim()
}

$workRoot = Join-Path $env:TEMP ("Rippr-Setup-" + [guid]::NewGuid().ToString("N"))
$payloadRoot = Join-Path $workRoot "payload"
$packageRoot = Join-Path $workRoot "package"
$downloadRoot = Join-Path $workRoot "downloads"
$persistentRoot = Join-Path $InstallRoot $Version
$persistentPackage = Join-Path $persistentRoot ("Rippr-" + $Version + ".ccx")

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot, $packageRoot, $downloadRoot, $persistentRoot | Out-Null
    $payloadZip = Join-Path $PSScriptRoot "rippr-payload.zip"
    if (!(Test-Path -LiteralPath $payloadZip)) {
        throw "The installer payload is missing. Rebuild the Windows installer."
    }

    Write-Step "Preparing Rippr $Version"
    Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadRoot -Force
    $pluginSource = Join-Path $payloadRoot "plugin-dist"
    $helperSource = Join-Path $payloadRoot "rippr-helper.exe"
    if (!(Test-Path -LiteralPath (Join-Path $pluginSource "manifest.json"))) {
        throw "The plugin payload is incomplete."
    }
    if (!(Test-Path -LiteralPath $helperSource)) {
        throw "The native helper payload is missing."
    }
    $uninstallerSource = Join-Path $PSScriptRoot "uninstall-rippr.ps1"
    $uninstallerCmdSource = Join-Path $PSScriptRoot "uninstall-rippr.cmd"
    if (!(Test-Path -LiteralPath $uninstallerSource) -or !(Test-Path -LiteralPath $uninstallerCmdSource)) {
        throw "The uninstaller payload is missing. Rebuild the Windows installer."
    }
    if ($ValidateOnly) {
        Write-Host "Payload validation passed for Rippr $Version." -ForegroundColor Green
        return
    }

    Copy-Item -Path (Join-Path $pluginSource "*") -Destination $packageRoot -Recurse -Force
    $vendorRoot = Join-Path $packageRoot "vendor\windows-x64"
    $licenseRoot = Join-Path $packageRoot "licenses"
    New-Item -ItemType Directory -Force -Path $vendorRoot, $licenseRoot | Out-Null
    Copy-Item -LiteralPath $helperSource -Destination (Join-Path $vendorRoot "rippr-helper.exe") -Force
    $noticeFile = Join-Path $PSScriptRoot "THIRD-PARTY-NOTICES.txt"
    if (Test-Path -LiteralPath $noticeFile) {
        Copy-Item -LiteralPath $noticeFile -Destination (Join-Path $licenseRoot "THIRD-PARTY-NOTICES.txt") -Force
    }

    Write-Step "Downloading yt-dlp"
    $ytDlpPath = Join-Path $downloadRoot "yt-dlp.exe"
    Download-File $YtDlpUrl $ytDlpPath
    $ytDlpVersion = Get-ToolVersion $ytDlpPath @("--version")
    Copy-Item -LiteralPath $ytDlpPath -Destination (Join-Path $vendorRoot "yt-dlp.exe") -Force
    try {
        Download-File $YtDlpLicenseUrl (Join-Path $licenseRoot "yt-dlp-LICENSE.txt")
    } catch {
        Write-Warning "Could not download the yt-dlp license text; retain the upstream license with the release."
    }

    Write-Step "Downloading FFmpeg and FFprobe"
    $ffmpegArchive = Join-Path $downloadRoot "ffmpeg.zip"
    $ffmpegExtracted = Join-Path $downloadRoot "ffmpeg"
    Download-File $FfmpegUrl $ffmpegArchive
    Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtracted -Force
    $ffmpegSource = Find-RequiredBinary $ffmpegExtracted "ffmpeg.exe"
    $ffprobeSource = Find-RequiredBinary $ffmpegExtracted "ffprobe.exe"
    $ffmpegVersion = Get-ToolVersion $ffmpegSource @("-version")
    Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $vendorRoot "ffmpeg.exe") -Force
    Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $vendorRoot "ffprobe.exe") -Force
    $ffmpegLicenses = Get-ChildItem -LiteralPath $ffmpegExtracted -Recurse -File | Where-Object { $_.Name -match "^(LICENSE|COPYING|README)" }
    foreach ($ffmpegLicense in $ffmpegLicenses) {
        Copy-Item -LiteralPath $ffmpegLicense.FullName -Destination (Join-Path $licenseRoot "FFmpeg-$($ffmpegLicense.Name)") -Force
    }

    [ordered]@{
        rippr = $Version
        ytDlp = $ytDlpVersion
        ffmpeg = $ffmpegVersion
        installedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot "versions.json") -Encoding UTF8

    $packageZip = Join-Path $workRoot ("Rippr-" + $Version + ".zip")
    Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $packageZip -CompressionLevel Optimal -Force
    Copy-Item -LiteralPath $packageZip -Destination $persistentPackage -Force
    Copy-Item -LiteralPath $uninstallerSource -Destination (Join-Path $InstallRoot "uninstall-rippr.ps1") -Force
    Copy-Item -LiteralPath $uninstallerCmdSource -Destination (Join-Path $InstallRoot "Uninstall-Rippr.cmd") -Force

    Write-Step "Opening the Rippr plugin installer"
    if (!$SkipLaunch) {
        try {
            Start-Process -FilePath $persistentPackage
            Write-Host "Creative Cloud should now install Rippr into Premiere Pro." -ForegroundColor Green
            Write-Host "Restart Premiere Pro after Creative Cloud finishes installing the plugin."
        } catch {
            Write-Warning "Windows could not open the .ccx automatically. Double-click this file to install Rippr:"
            Write-Host $persistentPackage -ForegroundColor Yellow
        }
    }

    Write-Host "`nRippr $Version is ready." -ForegroundColor Green
    Write-Host "Installer package: $persistentPackage"
    Write-Host "Installed package cache: $persistentRoot"
    Write-Host "Uninstaller: $(Join-Path $InstallRoot 'Uninstall-Rippr.cmd')"
} catch {
    Write-Host "`n[FAILED] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "The installer has not removed your existing Rippr installation."
    exit 1
} finally {
    if (!$KeepWorking -and (Test-Path -LiteralPath $workRoot)) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
