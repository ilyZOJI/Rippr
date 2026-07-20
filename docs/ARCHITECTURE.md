# Architecture

```text
Premiere Pro
  Rippr UXP panel (TypeScript, Vite, Spectrum)
    UI + state
    UXP filesystem picker
    Premiere project/bin/import adapter
    typed WebSocket client
             | JSON-RPC + events on loopback
             v
  Rippr helper (Rust, Tokio)
    yt-dlp analyzer/downloader
    FFmpeg conversion through yt-dlp
    progress + cancellation
    versioned configuration + presets
    persistent history
    platform path/reveal/dependency services
```

## Boundary rules

- UI code never launches commands or branches on operating-system behavior.
- The helper binds only to loopback and validates all request payloads.
- Premiere DOM calls live in one adapter and are never sent to the helper.
- IPC messages are defined in `shared/protocol.schema.json` and mirrored by strict TypeScript/Rust types.
- Configuration includes a schema version and is migrated before use.
- Paths are represented as native absolute strings only at system boundaries.

## Helper discovery

During development, start the helper with `pnpm dev:helper`. Production packages place one signed native binary under the plugin's target-specific vendor directory. The panel can request that UXP open that binary when the helper is offline; UXP always controls user consent.

## Security

Rippr never exposes a non-loopback listener. Download URLs are passed as command arguments without an intermediate shell, preventing command injection. Filenames and destinations are validated, and the helper owns all process execution. Network permission is broad because yt-dlp supports a changing set of sites and thumbnails can originate from their CDNs.

