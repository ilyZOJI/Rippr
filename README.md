# Rippr

Rippr is a cross-platform Adobe Premiere UXP panel for analyzing, downloading, converting, and automatically importing authorized online media without leaving Premiere.

The project is split into a TypeScript/Vite UXP panel and a Rust/Tokio helper. The panel owns user experience and Premiere project integration; the helper owns yt-dlp, FFmpeg, downloads, filesystem operations, configuration, history, and dependency management.

## Prerequisites

- Adobe Premiere Pro 25.6 or newer
- Adobe UXP Developer Tool 2.2 or newer
- Node.js 20 or newer and pnpm 11
- Rust 1.85 or newer
- yt-dlp and FFmpeg available on `PATH`, configured explicitly in Settings, or bundled under `vendor/<target>/`

## Development

```bash
pnpm install
pnpm dev:helper
pnpm dev
```

Open the URL printed by Vite for browser UI development. Add `?mock=1` for a fully populated, dependency-free preview. For Premiere, build the panel with `pnpm build:plugin`, then load `plugin/dist/manifest.json` in UXP Developer Tool.

The helper listens only on `127.0.0.1:43117`. The panel reconnects automatically and exposes actionable dependency diagnostics if yt-dlp or FFmpeg is unavailable.

## Validation

```bash
pnpm test
pnpm lint
pnpm build
```

## Packaging

Build native helper binaries for `aarch64-apple-darwin`, `x86_64-apple-darwin`, and `x86_64-pc-windows-msvc`, place them under the matching `vendor/` target directory, then run `pnpm package:stage`. Signing, Apple notarization, Adobe Marketplace IDs, and final `.ccx` packaging require publisher credentials and Adobe UXP Developer Tool.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Only download media you own or are authorized to download.

