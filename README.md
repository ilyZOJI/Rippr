# Rippr

Rippr is an Adobe Premiere Pro panel for analyzing, downloading, converting,
and importing media from URLs without leaving Premiere. It combines a
responsive UXP panel with a local Rust helper that owns downloads, conversion,
configuration, history, and filesystem work.

> **Version 1.0.0 release candidate**
>
> The Windows installer is built and tested automatically, but the generated
> installer is unsigned until it is signed with the publisher's Authenticode
> certificate. Complete Creative Cloud/Premiere testing on a clean Windows
> machine is still required before public distribution.

## What it does

- Analyzes a URL and shows available formats, quality, codecs, duration, and size.
- Downloads video or audio as MP4, MOV, MKV, WAV, MP3, FLAC, or the original format.
- Converts incompatible video to Premiere-ready H.264/AAC MP4 when requested.
- Stages conversion sources in a temporary Rippr folder by default and removes them afterward.
- Sanitizes Windows-invalid title characters and avoids overwriting existing files.
- Imports completed media into the active Premiere project and selected project bin.
- Provides destination presets, naming templates, history, retries, cancellation, and dependency diagnostics.
- Runs the helper on loopback only (`127.0.0.1:43117`).

## Windows installation

The installer is intended for Windows 10/11 x64 and Adobe Premiere Pro 25.6 or
newer.

1. Download `Rippr-Setup-1.0.0.exe` from the repository's GitHub Release.
2. Double-click it and allow the setup to download yt-dlp and FFmpeg/FFprobe.
3. Creative Cloud will open the generated Rippr `.ccx` package.
4. Approve the Creative Cloud installation, restart Premiere Pro, and open
   **Window > Extensions > Rippr** (the exact menu label can vary by Premiere build).

The installer stores the versioned package and downloaded tools under:

```text
%LOCALAPPDATA%\Rippr\1.0.0\
```

If Creative Cloud does not open automatically, the installer prints the `.ccx`
path so it can be opened manually. A Creative Cloud installation and a
Premiere restart are required; the EXE cannot silently inject a panel into a
running Premiere process.

Only download media that you own or are authorized to download, and comply
with the terms of the source website.

## Browser preview

The panel can be previewed without Premiere or native dependencies:

```bash
pnpm install
pnpm dev
```

Open the URL printed by Vite and append `?mock=1` to exercise analysis,
downloads, progress, history, presets, settings, and notifications with mock
data.

## Development setup

### Requirements

- Windows 10/11, macOS, or Linux for development
- Node.js 20 or newer
- pnpm 11
- Rust 1.85 or newer
- Adobe Premiere Pro 25.6 or newer for host testing
- Adobe UXP Developer Tool 2.2 or newer for loading the panel in Premiere
- yt-dlp and FFmpeg/FFprobe on `PATH`, configured in Settings, or placed in
  `vendor/<target>/`

### Run locally

```bash
pnpm install
pnpm dev:helper
pnpm dev
```

For Premiere testing, build the panel and load its manifest in UXP Developer
Tool:

```bash
pnpm build:plugin
# Load plugin/dist/manifest.json in Adobe UXP Developer Tool
```

On Windows, `Open-Rippr-Admin-PowerShell.cmd` opens an elevated PowerShell in
the repository and runs the test flow. The `-Only` variant only opens the
elevated shell. The equivalent automated test command is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-rippr.ps1
```

The macOS test launcher is `scripts/test-rippr.command`.

## Validation commands

Run these before opening a pull request or publishing a build:

```bash
pnpm test          # TypeScript checks + Rust tests
pnpm format:check  # Rust formatting
pnpm lint          # Clippy with warnings denied
pnpm build         # Production panel + release helper
```

## Build the Windows installer

From a Windows PowerShell prompt in the repository:

```powershell
pnpm install
pnpm package:windows-installer
```

The output is:

```text
dist/windows/Rippr-Setup-1.0.0.exe
```

The EXE embeds the production panel and native helper. When a user runs it,
the installer downloads the Windows yt-dlp release and FFmpeg essentials
build, records their versions, creates a `.ccx` package, and opens that
package for Creative Cloud. The generated installer is intentionally ignored
by Git; publish it as an asset on a GitHub Release rather than committing the
binary to the source repository.

Before publishing, the release owner should:

1. Authenticode-sign the EXE and verify the signature on a clean Windows machine.
2. Test installation, analysis, a large download, conversion, cancellation,
   and Premiere import with Creative Cloud and Premiere 25.6+.
3. Confirm the downloaded yt-dlp/FFmpeg versions and retain their upstream
   license files in the package.
4. Upload the signed EXE and its SHA-256 checksum to a GitHub Release.

## Repository layout

```text
plugin/       TypeScript/Vite UXP panel and Premiere adapter
helper/       Rust/Tokio loopback helper, downloads, conversion, and storage
shared/       Shared TypeScript protocol types and schema
scripts/      Development, testing, staging, and Windows packaging scripts
docs/         Architecture, requirements, development, and release notes
vendor/       Native-binary layout and third-party notices (binaries are not committed)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for implementation details.

## Security and privacy

The helper binds only to loopback and launches tools without an intermediate
shell. Rippr does not provide a public server or upload downloaded media. The
panel requests broad network permission because yt-dlp supports many changing
websites and thumbnail CDNs; use it only with sources you are authorized to
access.

## Third-party software

Release packages use yt-dlp and FFmpeg/FFprobe. Their upstream notices and
license-handling requirements are documented in
[`vendor/THIRD-PARTY-NOTICES.txt`](vendor/THIRD-PARTY-NOTICES.txt).

## License

This repository currently has no license file. Until the project owner adds a
license, normal copyright applies and reuse/distribution permissions should
not be assumed.
