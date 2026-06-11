---
name: pdf2md
description: >-
  Convert PDFs to clean Markdown FAST, before reading them. Use whenever you
  need the text/tables of any PDF (papers, reports, specs, forms, contracts,
  letters) instead of loading the PDF or its page images into context. Returns
  structured markdown (headings, lists, GFM tables, correct multi-column
  reading order, headers/footers stripped) in ~10ms per document, using ~10x
  fewer tokens than reading page images.
---

# pdf2md — read PDFs as Markdown, not images

**Never load a PDF into context as page images or raw bytes.** A single page
sent as an image costs ~1,500–2,000 tokens and is slow; a 30-page paper is
~50k tokens before you've understood a word. Convert it first and read the
markdown.

## Usage

```bash
~/.claude/skills/pdf2md/bin/pdf2md <file.pdf>              # markdown to stdout
~/.claude/skills/pdf2md/bin/pdf2md a.pdf b.pdf c.pdf       # several at once
~/.claude/skills/pdf2md/bin/pdf2md <file.pdf> --stats      # + token-savings line on stderr
```

(If `pdf2md` is on PATH, just `pdf2md <file.pdf>`.)

The workflow is always the same:

1. You encounter a PDF you need to understand.
2. Run `pdf2md <file.pdf>` and read the markdown it prints.
3. Only fall back to a vision read if the markdown is clearly insufficient —
   i.e. a scanned/image-only PDF with no text layer (pdf2md targets
   born-digital PDFs; it does not OCR).

## Efficiency rules

- **Batch:** converting several PDFs? Pass them all in ONE invocation
  (`pdf2md a.pdf b.pdf`) — the engine warms up once. Output sections are
  separated by `<!-- pdf2md: path -->` comment lines.
- **Big documents:** convert once, save to a file, then search/read the
  markdown selectively instead of re-converting:
  `pdf2md big.pdf > big.md && grep -n "what you need" big.md`
- **Don't post-process:** the output already strips page numbers, running
  headers/footers, and bibliographies, de-hyphenates line wraps, and renders
  tables as GFM pipe tables in human reading order.

## What you get

- Headings (`#`/`##`/`###`), paragraphs, ordered/nested lists.
- GFM pipe tables reconstructed from layout (incl. side-by-side table blocks
  emitted as separate stacked tables).
- Correct reading order for two-column layouts (academic papers).
- Page furniture (page numbers, running headers/footers) and reference
  sections stripped.

## Why trust it

Benchmarked continuously against `pdftotext`, `markitdown`, and a naive
extractor on real PDFs (arXiv papers, IRS forms, SEC-style letters, RFCs,
court opinions, datasheets): first on every quality dimension, ~10ms median
vs ~90ms (pdftotext) and ~300ms+ (markitdown). Source + benchmarks:
https://github.com/mgranados/pdf2md
