#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$target"
  cargo build --manifest-path helper/Cargo.toml --release --target "$target"
done

mkdir -p vendor/macos-arm64 vendor/macos-x64
cp target/aarch64-apple-darwin/release/rippr-helper vendor/macos-arm64/rippr-helper
cp target/x86_64-apple-darwin/release/rippr-helper vendor/macos-x64/rippr-helper

echo "macOS helper binaries are staged. Build x86_64-pc-windows-msvc on a Windows CI runner."

