# Bundled native tools

Release builds place signed, platform-specific binaries in these directories:

```text
vendor/
  macos-arm64/
    rippr-helper
    yt-dlp
    ffmpeg
    ffprobe
  macos-x64/
    rippr-helper
    yt-dlp
    ffmpeg
    ffprobe
  windows-x64/
    rippr-helper.exe
    yt-dlp.exe
    ffmpeg.exe
    ffprobe.exe
```

The binaries are intentionally not committed. Preserve the yt-dlp and FFmpeg license files in release packages and update `versions.json` during staging.

