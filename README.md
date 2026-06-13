# pdf2md

Turn a PDF into clean Markdown in ~10 milliseconds.

```bash
git clone https://github.com/mgranados/pdf2md && cd pdf2md
scripts/fetch-pdfium.sh && cargo build --release

./target/release/pdf2md report.pdf
```

```markdown
# Plan Comparison

The plans differ in limits and price.

| Plan | Seats | Storage | Price |
| --- | --- | --- | --- |
| Solo | 1 | 5 GB | $0 |
| Team | 10 | 100 GB | $49 |
```

Headings, lists, real tables (even ruled grids), two-column papers in reading
order — with page numbers, running headers, and bibliographies already
stripped, and hyphenated line breaks healed. One small native binary (Rust +
pdfium). No Python, no ML models, no network, no accounts. MIT, free forever.

## Why this one?

Every claim is benchmarked and gated against `pymupdf4llm`, `markitdown`,
and `pdftotext` (`pnpm eval` fails if pdf2md loses its lead) — on judged quality, hand-labelled tables, noise, text
fidelity, and an external test set we didn't author:

|  | pdf2md | next best |
|---|---|---|
| typical document | **~9 ms** | ~90 ms (pdftotext) |
| judged quality, 20 real docs | **5.8 / 10** | 5.7 (pymupdf4llm) |
| table reconstruction (content F1) | **0.94** | 0.14 (markitdown) |

Numbers, methodology, and how to reproduce them: **[docs/benchmarks.md](docs/benchmarks.md)**.

## 🤖 Using an AI agent? Start here

pdf2md was built so agents never load a PDF into context — convert first,
read the Markdown, spend ~10× fewer tokens than reading pages as images.
**[docs/agents.md](docs/agents.md)** explains the benefits and setup for all
three shapes:

- **Claude Code skill** — `scripts/install-skill.sh` (one command; the agent
  then reaches for it automatically whenever it meets a PDF)
- **MCP server** — `pdf2md --mcp` works with any MCP client; warm engine,
  low-millisecond conversions
- **Plain CLI** — `pdf2md a.pdf b.pdf --stats` batches files and reports the
  exact tokens saved

There's also an [`llms.txt`](llms.txt) index if you *are* an agent reading
this right now.

## Scope

Born-digital PDFs (anything with a text layer): papers, reports, forms,
invoices, contracts, datasheets, legal opinions. It deliberately does not
OCR — for scanned documents, use a vision model.

MIT. Character decoding by [pdfium](https://pdfium.googlesource.com/pdfium/)
(Google's PDF engine — the same foundation marker and docling build on); every
layer above the raw glyphs — words, columns, reading order, tables, headings,
noise stripping — is pdf2md's own.
