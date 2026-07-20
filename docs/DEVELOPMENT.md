# Development and release

## Local workflow

1. Install JavaScript dependencies with `pnpm install`.
2. Install yt-dlp and FFmpeg, or set their absolute paths in Rippr Settings.
3. Start the Rust helper with `pnpm dev:helper`.
4. Run `pnpm dev` for a browser UI preview, or `pnpm build:plugin` for UXP.
5. In UXP Developer Tool, add `plugin/dist/manifest.json`, load it, and open Rippr from Window > UXP Plugins.

The browser preview uses the same UI. Add `?mock=1` to exercise analysis, progress, history, presets, settings, and notifications without external binaries.

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

