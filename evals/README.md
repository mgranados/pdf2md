# evals — strict rival benchmark

Scores PDF→Markdown converters on **speed** and **quality** against exact ground truth, and gates `pdf2md` on being the fastest _and_ most accurate. Pure orchestration in TypeScript run directly by Node (≥23.6, native type stripping — no build step); rivals and the judge are subprocesses.

```
src/
  corpus.ts            synthetic docs: build(PDF) + exact ground-truth markdown
  generate-corpus.ts   renders synthetic corpus -> corpus/_out/*.pdf + *.gt.md
  fetch-real.ts        downloads real PDFs from corpus/real/sources.json -> _pdfs/
  real-corpus.ts       loads real PDFs as reference-free eval docs
  converters.ts        rival registry (plugins) + built-in naive-pdfjs baseline
  pdf2md-proto.ts      the converter: TS reference impl of the heuristics
  bench.ts             wall-clock speed (median / p95 / pages-per-sec)
  judge.ts             LLM-as-judge via the claude CLI — ground-truth + reference-free modes
  table-bench.ts       deterministic table metric (GriTS-content-inspired) over
                       hand-labelled real tables in corpus/tables/labels.json
  leaderboard.ts       aggregate + render + CI gates
  run.ts               orchestrator (both corpora)
```

## Table benchmark (deterministic, no LLM)

`pnpm run eval:tables` scores converters against **hand-labelled grids from the real PDFs** (`corpus/tables/labels.json`, each verified against an independent `pdftotext -layout` extraction): Berkshire financials ×2, the Attention paper's BLEU + complexity tables, ResNet's error table, a GPT-3 results table, an IRS tax-bracket slice, and a Schedule C expense-line slice. For each labelled grid it finds the best-matching predicted pipe table + row window, aligns cells (sequence alignment, bigram-Dice cell similarity), and scores content F1 in [0,1] — GriTS-content in spirit. This exists because the reference-free judge's ±0.3 noise cannot guide table work; this metric can (and caught every fix/regression during development). `--show <tool>` dumps the best-match windows.

**Region segmentation + block splitting:** a table region is first segmented into runs of structurally-compatible rows (sliding-window cell-signature comparison; small fragments like headers merge forward with their data), then each segment is checked for side-by-side blocks (a gutter ≫ the median column gutter with ≥2 cells on *both* sides in most rows) and split into stacked tables. This is what turns Schedule C's two-block expense layout into separate line-item tables (label score 0.26 → 0.70; the residual is dot-leader noise in the blank form's box cells). ResNet's Table 1 (multi-row bracket cells) is deliberately *not* labelled: its "correct" grid is ambiguous even for a human.

## Run

```bash
pnpm run eval                       # speed + quality
pnpm run eval -- --bench-only       # speed only (no claude calls)
pnpm run eval -- --judge-only       # quality only (1 conversion each)
pnpm run eval -- --iterations 8     # more speed samples
pnpm run eval -- --converters pdf2md,markitdown   # subset
pnpm run eval -- --model opus       # heavier judge
pnpm run eval -- --no-cache         # force fresh judgements
```

## The corpus is code

Every doc in `corpus.ts` is a born-digital PDF built with `pdfkit`, paired with the exact markdown it should convert to. That means **ground truth is free and precise**, the corpus is diffable, and nothing binary lives in git. Adversarial layouts (multi-column, tables) are deliberate — that's where the fast-but-dumb tools fail.

The synthetic set is deliberately adversarial but *self-authored* — the converter is tuned on the same shapes it's graded on, which flatters it. That's why the **real-world corpus** exists alongside it.

## Real-world PDFs (reference-free)

`pnpm run corpus:real` downloads the PDFs in `corpus/real/sources.json` (arXiv papers, the Bitcoin whitepaper, …) into `corpus/real/_pdfs/` (gitignored — only URLs are committed). Drop any `*.pdf` in there to add your own; no ground truth needed.

Real PDFs can't be auto-labelled, so they're judged **reference-free**: the judge scores intrinsic quality (structure, reading order, tables, noise, coherence) and gets a **char-count completeness signal** — the raw text-layer size vs the candidate's size — to catch dropped content without a reference document. These scores are *relative* indicators (which tool is cleaner on real docs), reported as a second board; the **ground-truth corpus remains the authoritative one the CI gates fire on.**

## Adding a rival

Add an entry to `CONVERTERS` in `converters.ts`:

```ts
{
  id: 'mytool',
  label: 'mytool 1.2',
  installHint: 'pipx install mytool',
  available: () => binExists('mytool'),
  convert: (pdf) => run('mytool', [pdf, '--stdout']),
}
```

Not-installed rivals are reported as **skipped** with their install hint — never silently dropped.

## pdf2md: reference impl now, Rust binary next

The `pdf2md` heuristics live in `src/pdf2md-proto.ts` (a TS reference impl) and are graded by default — they reproduce the corpus ground truth 5/5 exactly. The **quality gate already bites**: the run exits non-zero unless `pdf2md` is #1 on quality.

The shippable artifact is a Rust + pdfium port. Once built, point the harness at it so the **speed** gates are timed against a real spawned binary (the reference impl runs in-process, so its speed is flagged as indicative):

```bash
cargo build --release
PDF2MD_BIN=./target/release/pdf2md pnpm run eval
```

## How quality is scored

`judge.ts` sends ground truth + candidate to the `claude` CLI with a strict rubric and gets back JSON:

```json
{"text_fidelity":9,"structure":5,"tables":8,"reading_order":10,"noise":9,"notes":"…"}
```

Composite weighting (in `judge.ts`, tunable): text 0.35 · structure 0.25 · reading-order 0.20 · tables 0.15 · noise 0.05. Bump `RUBRIC_VERSION` to invalidate the cache when the rubric changes.

**Cost:** judging uses your claude **subscription**, not API tokens — and refuses to run if `ANTHROPIC_API_KEY` is set (pass `--allow-api` to override). Cached by hash of `(rubric, model, ground-truth, candidate)`, so re-runs are free and reproducible.
