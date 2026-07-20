$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

rustup target add x86_64-pc-windows-msvc
cargo build --manifest-path helper/Cargo.toml --release --target x86_64-pc-windows-msvc

New-Item -ItemType Directory -Force -Path vendor/windows-x64 | Out-Null
Copy-Item target/x86_64-pc-windows-msvc/release/rippr-helper.exe vendor/windows-x64/rippr-helper.exe

Write-Host "Windows helper binary staged in vendor/windows-x64."

