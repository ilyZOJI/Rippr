# Development and release

## Local workflow

1. Install JavaScript dependencies with `pnpm install`.
2. Install yt-dlp and FFmpeg, or set their absolute paths in Rippr Settings.
3. Start the Rust helper with `pnpm dev:helper`.
4. Run `pnpm dev` for a browser UI preview, or `pnpm build:plugin` for UXP.

On Windows, `powershell -ExecutionPolicy Bypass -File scripts/test-rippr.ps1`
runs the tests, builds the panel and helper, then restarts the workspace helper
on port 43117. It prints the helper logs and the generated plugin directory when
the panel is ready to test. The macOS equivalent is `scripts/test-rippr.command`.

To run the full Windows test/build/helper restart flow in an elevated PowerShell
window, double-click `Open-Rippr-Admin-PowerShell.cmd` at the repository root
and approve the Windows UAC prompt. It runs `scripts/test-rippr.ps1`, keeps the
window open, and prints the plugin path, helper PID/logs, and the next Premiere
testing steps when ready.

To only open an elevated PowerShell in the Rippr directory, double-click
`Open-Rippr-Admin-PowerShell-Only.cmd`.
5. In UXP Developer Tool, add `plugin/dist/manifest.json`, load it, and open Rippr from Window > UXP Plugins.

## Windows release installer

`powershell -ExecutionPolicy Bypass -File scripts/build-windows-installer.ps1`
builds `dist/windows/Rippr-Setup-1.0.0.exe` with the production plugin and
optimized native helper embedded. When a user runs the EXE, it downloads the
Windows yt-dlp and FFmpeg builds, assembles a Windows `.ccx` package with the
helper and tools beside it, and opens that package for Creative Cloud to install
into Premiere Pro. The user may need to approve the Creative Cloud prompt and
restart Premiere after installation.

The installer uses the upstream yt-dlp release endpoint and the Gyan.dev
FFmpeg Windows essentials build. Keep the upstream license files with every
published installer and verify the downloaded versions before publishing.
The generated EXE is unsigned in local builds; Authenticode-sign it before
public distribution and validate the complete Creative Cloud/Premiere flow on
a clean Windows machine.

The browser preview uses the same UI. Add `?mock=1` to exercise analysis, progress, history, presets, settings, and notifications without external binaries.

The Windows installation places `Uninstall-Rippr.cmd` under
`%LOCALAPPDATA%\Rippr`. It removes Rippr's local package cache and bundled
tools, then opens Creative Cloud for manual removal of the installed UXP panel.

## Native build matrix

| Target | Rust target | Output directory |
| --- | --- | --- |
| macOS Apple Silicon | `aarch64-apple-darwin` | `vendor/macos-arm64/` |
| macOS Intel | `x86_64-apple-darwin` | `vendor/macos-x64/` |
| Windows 10/11 | `x86_64-pc-windows-msvc` | `vendor/windows-x64/` |

Bundle yt-dlp, FFmpeg, and FFprobe beside the helper when distributing a self-contained package. Keep their licenses and version metadata in the same directory.

## Release gates

- `pnpm test`, `pnpm lint`, and `pnpm build` pass.
- UXP panel is tested at minimum, preferred, narrow, and tall dock sizes.
- Analyze/download/import are exercised on each target OS.
- Missing dependency, permission denial, disk-full, disconnect, cancellation, and removed-drive paths are exercised.
- Helper binaries are signed; macOS binaries are notarized.
- The production plugin ID is issued in Adobe Developer Console and the package is built with UXP Developer Tool.

