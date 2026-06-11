# pdf2md

Convert PDFs to clean Markdown in ~10 milliseconds. Free, MIT, no paid tier.

Headings, lists, tables (including ruled grids), correct multi-column reading
order — with page numbers, running headers/footers, and bibliographies
stripped. One small native binary, no Python, no ML models, no network.

```bash
git clone https://github.com/mgranados/pdf2md && cd pdf2md
scripts/fetch-pdfium.sh && cargo build --release

./target/release/pdf2md report.pdf            # markdown to stdout
./target/release/pdf2md a.pdf b.pdf --stats   # several files + token savings
./target/release/pdf2md --mcp                 # serve as an MCP tool
```

**Using an AI agent (Claude Code, MCP clients, or any LLM tool)?**
Read **[docs/agents.md](docs/agents.md)** — why converting PDFs to Markdown
saves ~10× the tokens of reading pages as images, and how to wire pdf2md up
as an agent skill, an MCP server, or a plain CLI. One-command skill install:
`scripts/install-skill.sh`.

**Is it actually good?** Every claim is benchmarked and CI-gated: fastest and
most accurate against `pymupdf4llm`, `markitdown`, and `pdftotext` on judged
quality, hand-labelled tables, noise, text fidelity — and on external ground
truth we didn't author. Numbers and methodology: **[docs/benchmarks.md](docs/benchmarks.md)**.

MIT. Built on [pdfium](https://pdfium.googlesource.com/pdfium/), Google's PDF engine.
