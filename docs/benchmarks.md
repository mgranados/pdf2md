# pdf2md benchmarks & methodology

Every claim pdf2md makes — fastest, most accurate, cleanest — is a number
produced by a benchmark in this repo and enforced as a gate: `pnpm eval` exits non-zero if any of them regresses. (Gates run locally today; hosted CI is the next milestone.) This document
explains the harness, the corpora, the five suites (LLM-judged quality,
hand-labelled tables, page-furniture noise, text fidelity, and external
validation on ground truth we didn't author), and the milestone history with
the measured result of every change.

Reproduce everything:

```bash
pnpm install
pnpm run corpus:real            # fetch the real-world PDF corpus (URLs only are committed)
PDF2MD_BIN=./target/release/pdf2md pnpm run eval             # judged quality + speed + gates
PDF2MD_BIN=./target/release/pdf2md pnpm run eval:tables      # hand-labelled table grids (deterministic)
PDF2MD_BIN=./target/release/pdf2md pnpm run eval:tables-external  # Tabula's own test pairs (external GT)
PDF2MD_BIN=./target/release/pdf2md pnpm run eval:noise       # furniture-leak counter (deterministic)
PDF2MD_BIN=./target/release/pdf2md pnpm run eval:text        # passage survival + broken-word rate
```

## Why a benchmark before a converter

"Speed is everything" and "most accurate" are only real if they're **numbers you defend on every commit**, not a slogan. The harness makes the claim falsifiable:

- **Speed** — wall-clock (median / p95 / pages-per-sec) over a corpus, including process-spawn cost because that's what an agent actually pays.
- **Quality** — an LLM-as-judge scores each conversion against exact ground truth on five dimensions (text fidelity, structure, tables, reading order, noise).
- **Gates** — once `pdf2md` exists, the build **fails** unless it's #1 on quality _and_ the fastest _and_ under the speed budget. Until then the gates report `UNPROVEN` — the harness refuses to pretend.

## Quality judging uses the `claude` CLI, not the API

Grading runs through the `claude` CLI in headless mode (`claude -p … --output-format json`). With no `ANTHROPIC_API_KEY` set, the CLI uses your **subscription**, so the benchmark **doesn't spend API tokens**. Safeguards:

- The judge **refuses to run if `ANTHROPIC_API_KEY` is set** (so a stray key can't silently start billing). Override with `--allow-api` if you really mean to.
- Every judgement is **cached by content hash** — re-runs are instant and cost zero quota. A full re-judge of an unchanged corpus is ~0.4s with no model calls.
- `--strict-mcp-config` keeps each call lean (no project MCP/context load).

## Quickstart

```bash
pnpm install
pnpm run corpus:real   # fetch real-world PDFs (papers + popular) — optional
pnpm run eval          # speed + quality leaderboard (calls the claude CLI)
pnpm run eval:speed    # speed only — no claude calls
pnpm run eval:tables   # deterministic table benchmark (no claude calls)
pnpm run corpus        # regenerate the synthetic corpus
```

Output lands in `evals/results/leaderboard.md` as **two boards**:

- **Ground-truth corpus** — synthetic docs generated from code (`evals/src/corpus.ts`), so the correct markdown is exact. Authoritative; this is what the quality gate fires on.
- **Real-world corpus** — actual PDFs (arXiv papers, the Bitcoin whitepaper, …) listed in `evals/corpus/real/sources.json` and fetched with `pnpm run corpus:real`. These have **no** ground truth, so they're scored **reference-free** (intrinsic quality + a char-count completeness signal). Drop any `*.pdf` into `evals/corpus/real/_pdfs/` to add your own. Only URLs are committed — never the PDF bytes.

## Broaden the field

The rivals are plugins; install any to include them automatically:

```bash
brew install poppler             # pdftotext (the fast-but-dumb floor)
pipx install 'markitdown[pdf]'   # Microsoft markitdown
python3 -m venv ~/.venvs/pdf2md-rivals && ~/.venvs/pdf2md-rivals/bin/pip install pymupdf4llm   # PyMuPDF-based pdf->md
pipx install docling             # IBM docling (heavy — ML models)
pipx install marker-pdf          # datalab marker (heavy — ML models)
```

## The converter: Rust binary + TS reference

The conversion heuristics (font-size → headings, whitespace/word-edge → columns, logical-row + grid → GFM tables, repeated boundary lines + bibliography → noise stripping) exist in two places:

- **`src/main.rs`** — the shippable **Rust binary** over [pdfium](https://pdfium.googlesource.com/pdfium/) (Google's C++ PDF engine via [`pdfium-render`](https://crates.io/crates/pdfium-render)). ~860 KB, ~10 ms median spawn+convert, ~110 ms on a 75-page paper. Two measured wins: pages opened by index (the crate's page *iterator* loads resources we never use), and a **stub system-font mapper** so pdfium uses its built-in substitution fonts instead of querying CoreText (first-page load 15 ms → 3 ms, byte-identical output on the whole corpus; `PDF2MD_SYSTEM_FONTS=1` restores the OS mapper).
- **`evals/src/pdf2md-proto.ts`** — the TS **reference impl** (over pdfjs) used to develop + validate the heuristics; it reproduces the synthetic ground truth exactly.

```bash
scripts/fetch-pdfium.sh        # download the prebuilt pdfium lib for your platform
cargo build --release          # -> target/release/pdf2md (847 KB)

pdf2md report.pdf              # clean markdown to stdout
pdf2md report.pdf --stats     # + a token-savings line on stderr (vs page-images)

# grade the binary on the benchmark instead of the TS reference:
PDF2MD_BIN=./target/release/pdf2md pnpm run eval
```

**Agent skill:** [`skills/pdf2md/SKILL.md`](../skills/pdf2md/SKILL.md) tells an agent to run `pdf2md` instead of loading a PDF as page images (~10× fewer tokens).

**pdfium library:** `scripts/fetch-pdfium.sh` pulls the right prebuilt `libpdfium` from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) into `pdfium-lib/` (gitignored). The binary finds it via `$PDFIUM_LIB_DIR`, then next to the executable, then `./pdfium-lib/lib`, then the system library — so a release is just `pdf2md` + `libpdfium` in one folder.

## Roadmap

1. **M0 — eval harness** ✅ — corpus, rival registry, speed bench, claude-CLI quality judge, two leaderboards + gates.
2. **M1 — heuristics** ✅ (TS reference impl) — headings, nested lists, multi-column reading order, GFM tables (logical-row + grid), noise/reference stripping.
3. **M2 — Rust + pdfium binary** ✅ — same heuristics as a single binary; all gates pass for real (quality #1, <1000 ms, fastest-vs-spawned).
4. **M3 — packaging + agent skill + fidelity** ✅ — `SKILL.md`, `--stats` token report, `fetch-pdfium.sh` + robust lib discovery; control-char stripping + soft-hyphen de-hyphenation for faithful text.
5. **M4 — faster + more accurate** ✅ — profiled the spawn path (page-open dominated; fonts, not glue) → indexed page access + stub font mapper = **24 ms → 10 ms median** with byte-identical output; heading detection hardened in both impls (quantized size threshold catches CVPR's 10.96-vs-9.96 subsections; equation-fragment and figure-debris filters) → real-world 5.6, all section headings recovered on papers.
6. **M5 — tables, measured properly** ✅ — built a **deterministic table benchmark** (`pnpm run eval:tables`: hand-labelled real tables, GriTS-content-style scoring — see [`evals/README.md`](../evals/README.md)), then fixed what it exposed: relaxed gutter coverage, **repeated-column-group fold** (IRS tax tables emit as stacked tables), **baseline-clustered cell reading**, split-decimal rejoin. Initial 5-label set: **0.864 → 0.996**; expanded to **8 labels** (GPT-3 results and Attention's math-cell table near-perfect out of the box).
7. **M6 — region segmentation + spanning cells** ✅ — table regions segment into runs of structurally-compatible rows (sliding-window cell signatures, fragments merge forward with their data), each segment splits at true block gutters (≥2 cells on both sides) — Schedule C's two-block form layout now emits as separate line-item tables (0.26 → 0.70). Cell assignment is **gap-gated**: content glued across a column boundary is a spanning cell and stays whole (`3.3 · 10^18` centered under two columns), and long labels no longer chop mid-word.
8. **M7 — breadth** ✅ — corpus grown to **14 real docs** with five new unseen types (RFC 9110, a SCOTUS slip opinion, a TI datasheet, FOMC minutes, a lecture deck); pdf2md stayed **#1 out of the box** (5.74 vs markitdown 5.03). The datasheet exposed and fixed a real bug: the page-level two-column splitter tore wide-gapped tables in half (guard: gutter-sharing lines that are mostly table rows mean a wide table, not a 2-column page). **Table benchmark: 0.933 over 9 labelled real tables** (markitdown 0.14; pdftotext/naive 0).
9. **M8 — noise** ✅ — new deterministic furniture benchmark (`pnpm run eval:noise`: verified running headers/footers that leak into output, counted as excess). Stripping upgraded: two-line boundary zones + **digit-normalized matching** (furniture varies only in its numbers — `[Page 5]`, `Lecture 1 - 23`) with a letters-guard so numeric table rows at page edges can never match. **Excess: 450 → 4**; judged noise dim 4.6 → 5.2 (pack: 3.1–3.6).
10. **M9 — text fidelity** ✅ — new deterministic text benchmark (`pnpm run eval:text`: hand-verified passages must survive output intact under alnum normalization, plus a dictionary **broken-word rate** compared across tools). pdf2md has the **lowest garble rate in the field** (17.95% vs naive 18.8%, markitdown 29.4%). Fix: a slack band in the page columnizer (justified prose grazing the gutter no longer falls to full-width and fragments paragraphs). One tracked miss: a Fed-minutes two-column page whose gutter midpoint is unstable under pdfium's padded glyph widths — an advance-width extraction rewrite was tried and **reverted** (it invalidated every gap calibration; tables 0.93→0.26 instantly caught by the benches).
11. **M12 — external validation + lattice tables** ✅ — added a benchmark we *didn't* author: the Tabula project's PDF + expected-CSV test pairs (`pnpm run eval:tables-external`), plus `pymupdf4llm` (the closest existing PDF→MD library) to the rival registry. First run was humbling — pdf2md lost 0.291 vs 0.467 — and exposed two real gaps, both fixed: **rotated pages** produced empty output (pdfium reports font size 0 on /Rotate pages and the sanity filter dropped every glyph), and **ruled (lattice) tables** were invisible to whitespace heuristics. New lattice mode reads vector rulings (thin paths + stroked-rect edges), builds cell grids from connected rulings, and arbitrates per region: lattice is a *fallback* used only where whitespace lacks the structure or the resolution. **External result: pdf2md 0.583 vs pymupdf4llm 0.467** — and the internal table benchmark *rose* to 0.937 (the datasheet's torn ratings table reunited at 0.94). A final **shape gate** (≤14 columns, ≥45% cell fill) keeps lattice off blank forms, whose box edges generate 63×62 pseudo-grids — that restored the judged board too: **5.77 vs pymupdf4llm's 5.44, #1 on every board, 140× faster (88 ms vs 12.4 s)**.
12. **M11 — performance, locked** ✅ — speed is now three enforced gates, set at achieved levels: **median ≤ 25 ms** on the benchmark corpus (measured ~9 ms), **≥ 300 pages/s mean on the real corpus** (measured ~452), and fastest-vs-spawned. Profiling found the remaining floor: per-char pdfium FFI (~57 ms of a 75-page doc is `loose_bounds` alone); three cheaper-extraction variants were tried, measured, and rejected because they traded quality the bench suites caught instantly. Dropped pdfium-render's `thread_safe` (per-call mutex) + `image` features — byte-identical output, less overhead. For agents: the MCP server (`--mcp`) is the fast path — warm engine, low-ms per document, zero spawn.

Each milestone is graded by `pnpm run eval`; the gates in [`evals/src/leaderboard.ts`](../evals/src/leaderboard.ts) are the definition of done.

## License

MIT. Always free. This is a library, not a product.
