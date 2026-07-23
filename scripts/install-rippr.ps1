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

function Test-OperationalTool([string]$Path, [string[]]$Arguments) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $output = @(& $Path @Arguments 2>&1)
        $exitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
        return (($null -eq $exitCode -or $exitCode -eq 0) -and $output.Count -gt 0)
    } catch {
        return $false
    }
}

function Find-OperationalTool([string]$Name, [string[]]$Arguments, [string[]]$Candidates) {
    foreach ($candidate in ($Candidates | Select-Object -Unique)) {
        if (![string]::IsNullOrWhiteSpace($candidate) -and (Test-OperationalTool $candidate $Arguments)) {
            return $candidate
        }
    }
    return $null
}

function Expand-ExistingPackages([string]$Root, [string]$Destination) {
    $roots = @()
    if (!(Test-Path -LiteralPath $Root -PathType Container)) {
        return $roots
    }
    $packages = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.ccx" -ErrorAction SilentlyContinue
    foreach ($package in $packages) {
        $extractRoot = Join-Path $Destination ([guid]::NewGuid().ToString("N"))
        $zipPath = Join-Path $Destination ([guid]::NewGuid().ToString("N") + ".zip")
        try {
            New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
            Copy-Item -LiteralPath $package.FullName -Destination $zipPath -Force
            Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
            $roots += $extractRoot
        } catch {
            Write-Warning "Could not inspect the previous Rippr package $($package.Name)."
            if (Test-Path -LiteralPath $extractRoot) {
                Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        } finally {
            if (Test-Path -LiteralPath $zipPath) {
                Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    return $roots
}

function Get-ExistingToolCandidates([string]$Root, [string[]]$PackageRoots, [string]$Name) {
    $candidates = New-Object System.Collections.Generic.List[string]
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $command -and $command.Source) {
        [void]$candidates.Add($command.Source)
    }
    if (Test-Path -LiteralPath $Root -PathType Container) {
        $runtimeTools = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "\\runtime\\vendor\\windows-x64\\" }
        foreach ($runtimeTool in $runtimeTools) {
            [void]$candidates.Add($runtimeTool.FullName)
        }
    }
    foreach ($packageRoot in $PackageRoots) {
        $packageTool = Join-Path $packageRoot ("vendor\\windows-x64\\" + $Name)
        if (Test-Path -LiteralPath $packageTool -PathType Leaf) {
            [void]$candidates.Add($packageTool)
        }
    }
    return @($candidates)
}

$workRoot = Join-Path $env:TEMP ("Rippr-Setup-" + [guid]::NewGuid().ToString("N"))
$payloadRoot = Join-Path $workRoot "payload"
$packageRoot = Join-Path $workRoot "package"
$downloadRoot = Join-Path $workRoot "downloads"
$existingPackageRoot = Join-Path $workRoot "existing-packages"
$persistentRoot = Join-Path $InstallRoot $Version
$persistentPackage = Join-Path $persistentRoot ("Rippr-" + $Version + ".ccx")
$runtimeVendorRoot = Join-Path $persistentRoot "runtime\\vendor\\windows-x64"

try {
    New-Item -ItemType Directory -Force -Path $payloadRoot, $packageRoot, $downloadRoot, $existingPackageRoot, $persistentRoot | Out-Null
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

    $previousPackages = @(Expand-ExistingPackages $InstallRoot $existingPackageRoot)
    $ytDlpCandidates = @(Get-ExistingToolCandidates $InstallRoot $previousPackages "yt-dlp.exe")
    $ffmpegCandidates = @(Get-ExistingToolCandidates $InstallRoot $previousPackages "ffmpeg.exe")
    $ffprobeCandidates = @(Get-ExistingToolCandidates $InstallRoot $previousPackages "ffprobe.exe")

    Copy-Item -Path (Join-Path $pluginSource "*") -Destination $packageRoot -Recurse -Force
    $vendorRoot = Join-Path $packageRoot "vendor\windows-x64"
    $licenseRoot = Join-Path $packageRoot "licenses"
    New-Item -ItemType Directory -Force -Path $vendorRoot, $licenseRoot | Out-Null
    Copy-Item -LiteralPath $helperSource -Destination (Join-Path $vendorRoot "rippr-helper.exe") -Force
    $noticeFile = Join-Path $PSScriptRoot "THIRD-PARTY-NOTICES.txt"
    if (Test-Path -LiteralPath $noticeFile) {
        Copy-Item -LiteralPath $noticeFile -Destination (Join-Path $licenseRoot "THIRD-PARTY-NOTICES.txt") -Force
    }

    Write-Step "Checking yt-dlp"
    $ytDlpPath = Join-Path $downloadRoot "yt-dlp.exe"
    $ytDlpSource = Find-OperationalTool "yt-dlp.exe" @("--version") $ytDlpCandidates
    if ($null -eq $ytDlpSource) {
        Write-Host "No operational yt-dlp was found; downloading a fresh copy."
        Download-File $YtDlpUrl $ytDlpPath
        $ytDlpSource = $ytDlpPath
    } else {
        Write-Host "Using operational yt-dlp at $ytDlpSource."
    }
    $ytDlpVersion = Get-ToolVersion $ytDlpSource @("--version")
    Copy-Item -LiteralPath $ytDlpSource -Destination (Join-Path $vendorRoot "yt-dlp.exe") -Force
    $existingYtDlpLicense = Get-ChildItem -LiteralPath $existingPackageRoot -Recurse -File -Filter "yt-dlp-LICENSE.txt" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $existingYtDlpLicense) {
        Copy-Item -LiteralPath $existingYtDlpLicense.FullName -Destination (Join-Path $licenseRoot "yt-dlp-LICENSE.txt") -Force
    } else {
        try {
            Download-File $YtDlpLicenseUrl (Join-Path $licenseRoot "yt-dlp-LICENSE.txt")
        } catch {
            Write-Warning "Could not download the yt-dlp license text; retain the upstream license with the release."
        }
    }

    Write-Step "Checking FFmpeg and FFprobe"
    $ffmpegArchive = Join-Path $downloadRoot "ffmpeg.zip"
    $ffmpegExtracted = Join-Path $downloadRoot "ffmpeg"
    $ffmpegSource = Find-OperationalTool "ffmpeg.exe" @("-version") $ffmpegCandidates
    $ffprobeSource = Find-OperationalTool "ffprobe.exe" @("-version") $ffprobeCandidates
    if ($null -eq $ffmpegSource -or $null -eq $ffprobeSource) {
        Write-Host "At least one operational FFmpeg tool was not found; downloading the FFmpeg bundle."
        Download-File $FfmpegUrl $ffmpegArchive
        Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtracted -Force
        if ($null -eq $ffmpegSource) {
            $ffmpegSource = Find-RequiredBinary $ffmpegExtracted "ffmpeg.exe"
        }
        if ($null -eq $ffprobeSource) {
            $ffprobeSource = Find-RequiredBinary $ffmpegExtracted "ffprobe.exe"
        }
    } else {
        Write-Host "Using operational FFmpeg at $ffmpegSource and FFprobe at $ffprobeSource."
    }
    $ffmpegVersion = Get-ToolVersion $ffmpegSource @("-version")
    $ffprobeVersion = Get-ToolVersion $ffprobeSource @("-version")
    Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $vendorRoot "ffmpeg.exe") -Force
    Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $vendorRoot "ffprobe.exe") -Force
    $ffmpegLicenses = Get-ChildItem -LiteralPath $existingPackageRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^FFmpeg-" }
    if ($ffmpegLicenses.Count -eq 0 -and (Test-Path -LiteralPath $ffmpegExtracted)) {
        $ffmpegLicenses = Get-ChildItem -LiteralPath $ffmpegExtracted -Recurse -File | Where-Object { $_.Name -match "^(LICENSE|COPYING|README)" }
    }
    foreach ($ffmpegLicense in $ffmpegLicenses) {
        $licenseName = if ($ffmpegLicense.Name -match "^FFmpeg-") { $ffmpegLicense.Name } else { "FFmpeg-$($ffmpegLicense.Name)" }
        Copy-Item -LiteralPath $ffmpegLicense.FullName -Destination (Join-Path $licenseRoot $licenseName) -Force
    }

    [ordered]@{
        rippr = $Version
        ytDlp = $ytDlpVersion
        ffmpeg = $ffmpegVersion
        ffprobe = $ffprobeVersion
        installedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot "versions.json") -Encoding UTF8

    $packageZip = Join-Path $workRoot ("Rippr-" + $Version + ".zip")
    Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $packageZip -CompressionLevel Optimal -Force
    Copy-Item -LiteralPath $packageZip -Destination $persistentPackage -Force
    New-Item -ItemType Directory -Force -Path $runtimeVendorRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $vendorRoot "yt-dlp.exe") -Destination (Join-Path $runtimeVendorRoot "yt-dlp.exe") -Force
    Copy-Item -LiteralPath (Join-Path $vendorRoot "ffmpeg.exe") -Destination (Join-Path $runtimeVendorRoot "ffmpeg.exe") -Force
    Copy-Item -LiteralPath (Join-Path $vendorRoot "ffprobe.exe") -Destination (Join-Path $runtimeVendorRoot "ffprobe.exe") -Force
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
