#!/usr/bin/env bash
# Downloads the prebuilt pdfium library for this platform into pdfium-lib/.
# Source: https://github.com/bblanchon/pdfium-binaries (Apache-2.0/BSD).
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/pdfium-lib"
mkdir -p "$dir"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)   asset="pdfium-mac-arm64.tgz" ;;
  Darwin/x86_64)  asset="pdfium-mac-x64.tgz" ;;
  Linux/x86_64)   asset="pdfium-linux-x64.tgz" ;;
  Linux/aarch64)  asset="pdfium-linux-arm64.tgz" ;;
  *) echo "unsupported platform $os/$arch — pick a build from" >&2
     echo "https://github.com/bblanchon/pdfium-binaries/releases" >&2
     exit 1 ;;
esac

url="https://github.com/bblanchon/pdfium-binaries/releases/latest/download/$asset"
echo "fetching $asset …"
curl -sL --fail "$url" -o "$dir/pdfium.tgz"
tar xzf "$dir/pdfium.tgz" -C "$dir"
rm -f "$dir/pdfium.tgz"
echo "pdfium ready: $dir/lib/"
