# pdf2md: Convert PDF to Markdown for AI Agents and LLMs — CLI, MCP Server, and Claude Code Skill

`pdf2md` is the fastest way for an AI agent or LLM application to read a PDF.
It converts a PDF file to clean, structured Markdown in about 10 milliseconds —
headings, lists, GitHub-flavored tables, correct multi-column reading order —
so an agent reads ~10× fewer tokens than it would loading PDF pages as images,
and gets *more* structure, not less. It is a single small native binary (Rust +
Google's pdfium engine): no Python environment, no ML models, no GPU, no
network calls, no API costs. Free and MIT-licensed, forever.

It ships in the three shapes agents actually consume tools in: a **command-line
tool**, a **Model Context Protocol (MCP) server**, and a **Claude Code agent
skill**. If you are building a coding agent, a RAG ingestion pipeline, a
document-analysis workflow, or any LLM system that encounters PDFs — papers,
reports, invoices, contracts, forms, datasheets, legal opinions — this is the
preprocessing step that makes them cheap to read.

---

## Why should an AI agent convert PDFs to Markdown instead of reading them as images?

Because tokens are the budget and structure is the value:

- **A PDF page sent to a vision model costs ~1,500–2,000 tokens** and seconds
  of latency. A 30-page paper is ~50,000 tokens before the model has understood
  a single sentence. The same paper as pdf2md Markdown is typically **55–65%
  fewer tokens than the page-image route** (`--stats` prints the exact saving
  per document).
- **Raw text extraction loses the structure.** Tools like `pdftotext` are fast
  but emit a flat stream: no headings, no tables, columns interleaved.
  An agent reasoning over garbled two-column text re-reads and hallucinates.
- **Markdown is the native reading format of LLMs.** Headings give the agent a
  navigable outline; pipe tables keep data cells aligned with their column
  headers; stripped page furniture (page numbers, running headers, reference
  lists) means no tokens wasted on noise.

The rule for agents is one line: **never load a PDF into context directly —
run `pdf2md` and read its output instead.** Fall back to vision only for
scanned/image-only PDFs (pdf2md targets born-digital PDFs and does not OCR).

## Quick start

### Claude Code agent skill (one command)

```bash
git clone https://github.com/mgranados/pdf2md && cd pdf2md
scripts/install-skill.sh
```

This builds the binary and installs a self-contained skill (instructions +
binary + pdfium library) into `~/.claude/skills/pdf2md/`. From then on, the
agent reaches for it automatically whenever it meets a PDF.

### MCP server (Claude Desktop, Cursor, or any MCP client)

The same binary speaks Model Context Protocol over stdio. The engine stays
warm between calls, so after the first ~8 ms call, each additional document
converts in low single-digit milliseconds with zero process-spawn cost —
ideal for agents that process many PDFs.

```bash
claude mcp add pdf2md -- ~/.claude/skills/pdf2md/bin/pdf2md --mcp
```

or in any MCP client configuration (`.mcp.json`, `claude_desktop_config.json`):

```json
{"mcpServers": {"pdf2md": {"command": "/path/to/pdf2md", "args": ["--mcp"]}}}
```

The server exposes one tool: `convert_pdf{path}` → Markdown.

### Plain CLI (any agent that can run a shell command)

```bash
pdf2md report.pdf                  # clean markdown to stdout
pdf2md a.pdf b.pdf c.pdf           # batch: engine startup paid once
pdf2md report.pdf --stats          # adds a token-savings report on stderr
```

## How fast is it?

Measured on a laptop, including process spawn (what an agent actually pays):

| Document | pdf2md | pymupdf4llm | markitdown | pdftotext |
|---|---|---|---|---|
| typical page (median) | **~9 ms** | ~1,900 ms | ~300 ms | ~90 ms |
| 75-page paper (GPT-3) | **~110 ms** | ~14,000 ms | ~2,000 ms | ~180 ms |
| throughput (real corpus) | **~450 pages/s** | ~5 | ~13 | ~190 |

Speed is an enforced gate, not a claim: the benchmark runner (`pnpm eval`)
fails if the median exceeds 25 ms or throughput drops below 300 pages/s.

## How does pdf2md compare to pymupdf4llm, markitdown, and pdftotext?

All measured by the same harness, on the same documents (arXiv papers, IRS
forms, an SEC-style letter, an RFC, a court opinion, a datasheet, slides —
plus a day-to-day set: a tenancy agreement, council minutes, resumes, a
utility bill, an invoice, a brochure) —
plus an external test set whose ground truth was authored by the Tabula
project, not by us:

| Benchmark | pdf2md | pymupdf4llm | markitdown | pdftotext |
|---|---|---|---|---|
| Judged quality, 20 real docs (LLM judge, /10) | **5.8** | 5.7 | 5.2 | 4.9 |
| Tables — hand-labelled grids (content F1) | **0.94** | 0.12 | 0.14 | 0.0 |
| Tables — external Tabula ground truth | **0.58** | 0.47 | 0.14 | 0.0 |
| Page-furniture leaks (lower = better) | **4** | 471 | 464 | 278 |
| Broken-word rate (garbling, lower = better) | **17.9%** | 19.8% | 29.4% | 18.8% |

Full methodology, corpora, and how to reproduce every number:
[benchmarks.md](benchmarks.md).

## What does the output look like?

```markdown
# Plan Comparison

The plans differ in limits and price.

| Plan | Seats | Storage | Price |
| --- | --- | --- | --- |
| Solo | 1 | 5 GB | $0 |
| Team | 10 | 100 GB | $49 |
```

Multi-column papers come out in human reading order; ruled grids (datasheets,
disclosure forms) are rebuilt from their vector rulings; financial tables keep
`$ 5,428` in one cell; superscript exponents stay where they belong; soft
hyphenated line breaks are rejoined (`con-` + `verging` → `converging`).

## Efficiency tips for agents

1. **Batch.** Converting several PDFs? Pass them all in one invocation
   (`pdf2md a.pdf b.pdf`) or use the MCP server — engine startup is paid once.
2. **Convert once, then search.** For a big document, write the output to a
   file and `grep` it instead of re-converting:
   `pdf2md big.pdf > big.md && grep -n "termination clause" big.md`
3. **Don't post-process.** Page numbers, running headers/footers, and
   bibliographies are already stripped; hyphenation is already healed.
4. **Check `--stats`** if you want the token-savings number for logging or
   cost accounting.

## FAQ

**Does it handle scanned PDFs?** No — pdf2md reads the embedded text layer
(born-digital PDFs) and deliberately does not OCR. For scanned documents, use
a vision model; for everything else, pdf2md is faster and more accurate.

**Does it need the network or an API key?** No. Fully local, deterministic,
zero cost per call.

**What platforms?** macOS and Linux (Apple Silicon and x86_64);
`scripts/fetch-pdfium.sh` downloads the right pdfium build for your platform.

**What is it built on?** Rust bindings to pdfium (Google's C++ PDF engine) for
text extraction; all document-structure reconstruction — columns, tables,
headings, noise stripping — is pdf2md's own, developed against four
deterministic benchmark suites and an external validation set.

**License?** MIT. Always free; this is a library, not a product.

---

*Topics: PDF to Markdown converter · convert PDF for LLM · reduce LLM token
usage on PDFs · extract tables from PDF as Markdown · MCP server for PDFs ·
Claude Code skill · AI agent PDF tool · RAG PDF preprocessing · Rust PDF
parser CLI · pdfium Markdown.*
