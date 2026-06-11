#!/usr/bin/env bash
# Build pdf2md and install it as a Claude Code agent skill:
#   ~/.claude/skills/pdf2md/{SKILL.md, bin/pdf2md, bin/libpdfium.*}
# Also prints the MCP registration one-liner for MCP-based agents.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# 1. pdfium library (skip if already present)
if ! ls pdfium-lib/lib/libpdfium.* >/dev/null 2>&1; then
  echo "› fetching pdfium…"
  scripts/fetch-pdfium.sh
fi

# 2. release binary
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found — install Rust first: https://rustup.rs" >&2
  exit 1
fi
echo "› building release binary…"
cargo build --release --quiet

# 3. install skill folder with binary + pdfium beside it (the binary finds the
#    library next to itself, so the skill folder is self-contained)
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/pdf2md"
mkdir -p "$dest/bin"
cp skills/pdf2md/SKILL.md "$dest/"
cp target/release/pdf2md "$dest/bin/"
cp pdfium-lib/lib/libpdfium.* "$dest/bin/"

echo "✓ skill installed: $dest"
echo
echo "Sanity check:"
"$dest/bin/pdf2md" 2>&1 | head -1 || true
echo
echo "Optional — register the MCP server (for MCP-based agents):"
echo "  claude mcp add pdf2md -- $dest/bin/pdf2md --mcp"
echo
echo "Or in any MCP client config (.mcp.json / claude_desktop_config.json):"
echo "  {\"mcpServers\": {\"pdf2md\": {\"command\": \"$dest/bin/pdf2md\", \"args\": [\"--mcp\"]}}}"
