// pdf2md — structure-reconstruction converter (TypeScript reference impl).
//
// This is the heuristics spike: the language-agnostic logic that turns a PDF's
// positioned text layer into structured markdown. The shippable artifact is a
// Rust + pdfium port of THIS logic; the harness swaps the binary in via
// PDF2MD_BIN. Born-digital PDFs only (no OCR) — by design.
//
// Pipeline (per page):
//   tokens -> detect column gutter -> split tokens into columns -> group lines
//   within each column -> reading-order groups -> classify into markdown.
// Detecting columns BEFORE grouping lines is what stops a two-column paper from
// collapsing into one wide line per row (which used to spawn spurious tables).
import { promises as fs } from 'node:fs';

interface Tok {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}
interface Line {
  toks: Tok[];
  text: string;
  cells: string[];
  cellX: number[]; // x of the first token in each cell — used for table alignment
  x: number;
  y: number;
  size: number;
}

const BULLET = /^[•·▪◦‣–-]\s+/;
const ORDERED = /^(\d+)[.)]\s+/;
const PAGE_NUM = /^\s*(page\s+)?\d+\s*$/i;

async function extractPages(pdfPath: string): Promise<Tok[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: Tok[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const toks: Tok[] = [];
    for (const it of content.items as any[]) {
      if (typeof it.str !== 'string' || it.str.trim() === '') continue;
      const t = it.transform;
      // Skip rotated text (vertical arXiv watermarks, margin stamps): for
      // horizontal text the off-diagonal terms are ~0.
      if (Math.abs(t[1]) > 0.2 || Math.abs(t[2]) > 0.2) continue;
      toks.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, size: Math.round((it.height || Math.abs(t[3])) * 2) / 2 });
    }
    pages.push(toks);
  }
  await doc.destroy();
  return pages;
}

function joinToks(toks: Tok[]): { text: string; cells: string[]; cellX: number[] } {
  let text = '';
  const cells: string[] = [];
  const cellX: number[] = [];
  let cell = '';
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (i === 0) cellX.push(tok.x);
    if (i > 0) {
      const prev = toks[i - 1];
      const gap = tok.x - (prev.x + prev.w);
      const ref = prev.size || tok.size || 11;
      if (gap > ref * 1.4) {
        cells.push(cell.trim());
        cell = '';
        cellX.push(tok.x);
        text += '\t';
      } else if (gap > ref * 0.18) {
        text += ' ';
        cell += ' ';
      }
    }
    text += tok.str;
    cell += tok.str;
  }
  cells.push(cell.trim());
  return { text: text.replace(/[ \t]+/g, (m) => (m.includes('\t') ? '\t' : ' ')).trim(), cells, cellX };
}

function makeLine(toks: Tok[]): Line {
  const sorted = [...toks].sort((a, b) => a.x - b.x);
  const { text, cells, cellX } = joinToks(sorted);
  return {
    toks: sorted,
    text,
    cells,
    cellX,
    x: sorted[0].x,
    y: Math.max(...sorted.map((t) => t.y)),
    size: Math.max(...sorted.map((t) => t.size)),
  };
}

// A run of multi-cell rows is a real table only if cell starts line up into
// >=2 columns shared by most rows. Ragged gaps (justified prose, scattered
// figure labels) fail this and are treated as plain text instead.
function isAlignedTable(rows: Line[]): boolean {
  const tol = 10;
  const clusters: { x: number; rows: Set<number> }[] = [];
  rows.forEach((r, ri) =>
    r.cellX.forEach((x) => {
      let c = clusters.find((cl) => Math.abs(cl.x - x) <= tol);
      if (!c) {
        c = { x, rows: new Set() };
        clusters.push(c);
      }
      c.rows.add(ri);
    }),
  );
  const strong = clusters.filter((c) => c.rows.size >= rows.length * 0.6);
  return strong.length >= 2;
}

// Reject runs whose cells are almost all tiny (1-2 chars): these are chart axis
// ticks / scattered figure labels, not data tables. Real tables carry labels,
// multi-digit numbers, or units (>=3 chars) in a meaningful fraction of cells.
function hasTableSubstance(rows: Line[]): boolean {
  const cells = rows.flatMap((r) => r.cells).filter((c) => c.length > 0);
  if (!cells.length) return false;
  const substantial = cells.filter((c) => c.length >= 3).length;
  return substantial / cells.length >= 0.3;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function clean(text: string): string {
  return text
    .replace(/\t/g, ' ')
    // collapse letter-spaced/tracked runs ("I R S" -> "IRS", "g o v" -> "gov")
    .replace(/(?<=^|\s)([A-Za-z0-9](?: [A-Za-z0-9]){2,})(?=$|\s|[.,;:)])/g, (m) => m.replace(/ /g, ''))
    .replace(/(?:\s*\.){4,}\s*/g, ' ') // dot leaders ("a . . . . b") -> single space
    .replace(/(\d) ?\. (\d)/g, '$1.$2') // re-join split decimals ("1 . 0" -> "1.0")
    .replace(/\s+/g, ' ')
    .trim();
}

function medianGap(lines: Line[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const pos = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  return pos.length ? pos[Math.floor(pos.length / 2)] : 0;
}

// Raw line grouping by vertical position. Returns token groups, top-to-bottom.
function groupRawLines(toks: Tok[]): Tok[][] {
  const sorted = [...toks].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Tok[][] = [];
  let cur: Tok[] = [];
  let curY = NaN;
  for (const tok of sorted) {
    const tol = Math.max(3, tok.size * 0.5);
    if (cur.length && Math.abs(tok.y - curY) > tol) {
      lines.push(cur);
      cur = [];
    }
    if (!cur.length) curY = tok.y;
    cur.push(tok);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Find a consistent central column gutter shared by many lines, or null.
function detectGutter(rawLines: Tok[][], minX: number, maxX: number): number | null {
  const W = maxX - minX;
  if (W <= 0) return null;
  const minGutter = Math.max(14, W * 0.03);
  const lo = minX + W * 0.3;
  const hi = minX + W * 0.7;
  const mids: number[] = [];
  let multi = 0;
  let tableish = 0;
  for (const line of rawLines) {
    if (line.length < 2) continue;
    multi++;
    const xs = [...line].sort((a, b) => a.x - b.x);
    let best = 0;
    let bestRight = NaN;
    let wideGaps = 0;
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i].x - (xs[i - 1].x + xs[i - 1].w);
      if (gap > Math.max(xs[i - 1].size, 11) * 1.4) wideGaps++;
      const mid = (xs[i].x + xs[i - 1].x + xs[i - 1].w) / 2;
      if (gap > best && mid > lo && mid < hi) {
        best = gap;
        bestRight = mid;
      }
    }
    if (best >= minGutter && Number.isFinite(bestRight)) {
      mids.push(bestRight);
      // a line with ADDITIONAL wide gaps beyond the candidate gutter is a
      // table row, not two-column prose
      if (wideGaps >= 2) tableish++;
    }
  }
  // Need the gutter in a real fraction of lines AND an absolute floor, so a
  // small N-row table doesn't masquerade as a column layout.
  if (mids.length < 6 || mids.length < multi * 0.4) return null;
  // If the gutter-sharing lines are mostly table rows (e.g. a datasheet's
  // label↔value gap), this is a wide-gapped TABLE, not a 2-column page —
  // columnizing would tear it in half.
  if (tableish / mids.length >= 0.75) return null;
  const sorted = [...mids].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const near = mids.filter((m) => Math.abs(m - median) <= W * 0.06);
  if (near.length < 6 || near.length < multi * 0.4) return null;
  return near.reduce((a, b) => a + b, 0) / near.length;
}

// Split a page's raw lines into reading-order groups using the gutter. Each
// returned group is a contiguous run whose lines may merge into paragraphs;
// paragraphs never merge across groups (so columns/bands stay separate).
function columnize(rawLines: Tok[][], G: number, minGutter: number): Line[][] {
  const groups: Line[][] = [];
  let leftBuf: Line[] = [];
  let rightBuf: Line[] = [];
  let fullBuf: Line[] = [];
  const flushCols = () => {
    if (leftBuf.length) groups.push(leftBuf);
    if (rightBuf.length) groups.push(rightBuf);
    leftBuf = [];
    rightBuf = [];
  };
  const flushFull = () => {
    if (fullBuf.length) groups.push(fullBuf);
    fullBuf = [];
  };
  // Tokens may protrude slightly into the gutter (justified prose whose right
  // edge grazes it); a small slack band keeps such lines splitting cleanly
  // instead of falling to full-width and fragmenting the column's paragraphs.
  const SLACK = 8;
  for (const toks of rawLines) {
    const left = toks.filter((t) => t.x < G && t.x + t.w <= G + SLACK);
    const right = toks.filter((t) => t.x >= G - SLACK && t.x + t.w > G);
    const cross = toks.filter((t) => t.x < G - SLACK && t.x + t.w > G + SLACK);
    const gutterGap =
      left.length && right.length && cross.length === 0
        ? Math.min(...right.map((t) => t.x)) - Math.max(...left.map((t) => t.x + t.w))
        : 0;

    if (left.length && right.length && cross.length === 0 && gutterGap >= minGutter - SLACK * 2) {
      // genuine two-column row: split at the gutter
      flushFull();
      leftBuf.push(makeLine(left));
      rightBuf.push(makeLine(right));
    } else if (cross.length || (left.length && right.length)) {
      // text flows across the gutter -> full-width line (title, caption, …)
      flushCols();
      fullBuf.push(makeLine(toks));
    } else {
      flushFull();
      (left.length ? leftBuf : rightBuf).push(makeLine(toks));
    }
  }
  flushFull();
  flushCols();
  return groups;
}

interface Furniture {
  exact: Set<string>;
  norm: Set<string>;
}

// Page furniture varies only in its numbers ("[Page 5]", "Lecture 1 - 23",
// dates) — normalize digit runs before comparing across pages.
function normFurniture(s: string): string {
  return s.replace(/\d+/g, '#');
}

// Running headers/footers live in the top/bottom TWO lines of a page (court
// opinions and datasheets use two-line headers/footers). Exact repeats on >=2
// pages are furniture; digit-normalized repeats need >=3 pages AND real words
// (>=4 letters) — the letters guard keeps numeric table rows that happen to
// sit at page boundaries (tax brackets, financials) from ever matching.
function findFurniture(pagesRaw: Tok[][][]): Furniture {
  const exactCount = new Map<string, number>();
  const normCount = new Map<string, number>();
  for (const raw of pagesRaw) {
    if (!raw.length) continue;
    const idxs = new Set([0, 1, raw.length - 2, raw.length - 1].filter((i) => i >= 0 && i < raw.length));
    for (const idx of idxs) {
      const txt = makeLine(raw[idx]).text;
      if (!txt) continue;
      exactCount.set(txt, (exactCount.get(txt) || 0) + 1);
      const n = normFurniture(txt);
      const letters = [...n].filter((c) => /\p{L}/u.test(c)).length;
      if (letters >= 4) normCount.set(n, (normCount.get(n) || 0) + 1);
    }
  }
  const exact = new Set<string>();
  for (const [t, c] of exactCount) if (c >= 2) exact.add(t);
  const norm = new Set<string>();
  for (const [t, c] of normCount) if (c >= 3) norm.add(t);
  return { exact, norm };
}

function isNoise(line: Line, furniture: Furniture): boolean {
  return PAGE_NUM.test(line.text) || furniture.exact.has(line.text) || furniture.norm.has(normFurniture(line.text));
}

function bodySizeOf(lines: Line[]): number {
  const freq = new Map<number, number>();
  for (const l of lines) freq.set(l.size, (freq.get(l.size) || 0) + 1);
  let best = 11;
  let bestN = -1;
  for (const [size, n] of freq) if (n > bestN) ((bestN = n), (best = size));
  return best;
}

// Quantized (0.5pt-step) heading threshold — immune to sub-point size noise.
const q = (s: number) => Math.round(s * 2);

function headingLevels(lines: Line[], body: number): Map<number, number> {
  const qbody = q(body);
  const bigger = [...new Set(lines.map((l) => l.size).filter((s) => q(s) >= qbody + 2))].sort((a, b) => b - a);
  const map = new Map<number, number>();
  bigger.forEach((s, i) => map.set(s, Math.min(3, i + 1)));
  return map;
}

// A plausible heading is text, not an equation fragment or figure debris.
function isHeadingText(s: string): boolean {
  if (/[∑∫≤≥≈∞±×÷√{}^_]/.test(s)) return false;
  const chars = [...s];
  if (!chars.length) return false;
  const ok = chars.filter((c) => /[\p{L}\p{N}\s.,:;()'&-]/u.test(c)).length;
  return ok / chars.length >= 0.85;
}

// Heading-size glyphs must dominate the line (guards against stray small-font
// tokens grouped into the same line).
function headingDominates(line: Line): boolean {
  const qs = q(line.size);
  const big = line.toks.filter((t) => q(t.size) === qs).length;
  return big * 10 >= line.toks.length * 7;
}

// Reconstruct a table by inferring GLOBAL column x-positions from all rows,
// then bucketing each row's tokens into those columns. This aligns cells (and
// empty cells) consistently, lines headers up with data, and keeps split
// fragments like "$" + "5,428" in the same column — unlike per-row cell packing.
// Column boundaries via vertical whitespace projection: an x-band that is empty
// across (almost) all rows is a column gutter — even when per-row gaps are too
// small for the cell-splitter to catch (e.g. tight numeric tax tables). Cross-
// row consistency is what keeps prose word-gaps from being read as columns.
interface ColInfo {
  x: number; // column start
  gutter: number; // width (pt) of the whitespace run before this column
}

function detectColumnsInfo(rows: Line[]): ColInfo[] {
  const toks = rows.flatMap((r) => r.toks);
  if (!toks.length) return [];
  const minX = Math.min(...toks.map((t) => t.x));
  const maxX = Math.max(...toks.map((t) => t.x + t.w));
  const W = maxX - minX;
  if (W <= 0) return [{ x: minX, gutter: 0 }];
  const bin = Math.max(1.5, W / 240);
  const nb = Math.ceil(W / bin) + 1;
  const cov = new Array(nb).fill(0);
  for (const r of rows) {
    const seen = new Set<number>();
    for (const t of r.toks) {
      const a = Math.max(0, Math.floor((t.x - minX) / bin));
      const b = Math.min(nb - 1, Math.floor((t.x + t.w - minX) / bin));
      for (let i = a; i <= b; i++) seen.add(i);
    }
    for (const i of seen) cov[i]++;
  }
  // A band is a gutter when covered in <=30% of rows: spanning cells and
  // centered headers may overlap a real column gutter in a minority of rows.
  const gutterMax = Math.floor(rows.length * 0.3);
  const minGutterBins = Math.max(2, Math.round(3 / bin)); // >= ~3pt of whitespace
  const cols: ColInfo[] = [];
  let inContent = false;
  let gutterRun = 0;
  for (let i = 0; i < nb; i++) {
    if (cov[i] <= gutterMax) {
      gutterRun++;
      if (gutterRun >= minGutterBins) inContent = false;
    } else {
      if (!inContent && (cols.length === 0 || gutterRun >= minGutterBins)) {
        cols.push({ x: minX + i * bin, gutter: cols.length === 0 ? 0 : gutterRun * bin });
      }
      inContent = true;
      gutterRun = 0;
    }
  }
  if (process.env.DEBUG_TABLES) {
    console.error('cols:', cols.map((c) => `${c.x.toFixed(0)}(g${c.gutter.toFixed(1)})`).join(' '));
  }
  return cols;
}

function detectColumns(rows: Line[]): number[] {
  return detectColumnsInfo(rows).map((c) => c.x);
}

// Segment a table region into runs of structurally-compatible rows: a row
// whose cell-start positions mostly miss the running column set starts a new
// segment. This is what keeps a form's differently-shaped sections (e.g.
// Schedule C's Part I vs the two-block Part II) from sharing one column grid.
function segmentByStructure(rows: Line[]): Line[][] {
  const tol = 10;
  const WINDOW = 3; // compare against the last few rows, not an ever-growing set
  const segs: Line[][] = [];
  let cur: Line[] = [];
  let recent: Line[] = [];
  for (const r of rows) {
    if (cur.length && r.cellX.length >= 2 && recent.length) {
      const sig = recent.flatMap((rr) => rr.cellX);
      const matched = r.cellX.filter((x) => sig.some((c) => Math.abs(c - x) <= tol)).length;
      if (matched / r.cellX.length < 0.6) {
        segs.push(cur);
        cur = [];
        recent = [];
      }
    }
    cur.push(r);
    recent.push(r);
    if (recent.length > WINDOW) recent.shift();
  }
  if (cur.length) segs.push(cur);
  // Keep only substantial splits: small fragments (header rows, section
  // banners) belong with the data below them — merge them forward. A split
  // survives only between two segments that are each real runs.
  const MIN_SEG = 5;
  const merged: Line[][] = [];
  let pending: Line[] = [];
  for (const s of segs) {
    if (s.length < MIN_SEG) {
      pending.push(...s);
    } else {
      merged.push([...pending, ...s]);
      pending = [];
    }
  }
  if (pending.length) {
    if (merged.length) merged[merged.length - 1].push(...pending);
    else merged.push(pending);
  }
  if (process.env.DEBUG_TABLES && merged.length > 1) {
    console.error('SEGMENTS:', merged.map((s) => `${s.length}r["${s[0].text.slice(0, 36)}"]`).join(' | '));
  }
  return merged;
}

// Side-by-side blocks: a gutter much wider than the segment's typical column
// gutter, with independent table structure (>=2 cells) on BOTH sides in most
// rows, splits the region into stacked tables (human reading order).
function blockBoundaries(rows: Line[]): number[] {
  const info = detectColumnsInfo(rows);
  const gutters = info.slice(1).map((c) => c.gutter).filter((g) => g > 0);
  if (gutters.length < 3) return [];
  const sorted = [...gutters].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const thresh = Math.max(18, med * 2.5);
  const bounds: number[] = [];
  for (let i = 1; i < info.length; i++) {
    if (info[i].gutter < thresh) continue;
    const x = info[i].x;
    let both = 0;
    let any = 0;
    for (const r of rows) {
      const left = r.cellX.filter((cx) => cx < x).length;
      const right = r.cellX.filter((cx) => cx >= x).length;
      if (left + right === 0) continue;
      any++;
      if (left >= 2 && right >= 2) both++;
    }
    if (any && both / any >= 0.5) bounds.push(x);
  }
  return bounds;
}

function buildTable(rows: Line[], depth = 0): string {
  // split side-by-side blocks first; each side rebuilds independently
  if (depth < 2) {
    const bounds = blockBoundaries(rows);
    if (bounds.length) {
      const edges = [-Infinity, ...bounds, Infinity];
      const blocks: string[] = [];
      for (let b = 0; b + 1 < edges.length; b++) {
        const blockRows: Line[] = [];
        for (const r of rows) {
          const toks = r.toks.filter((t) => t.x >= edges[b] && t.x < edges[b + 1]);
          if (toks.length) blockRows.push(makeLine(toks));
        }
        if (blockRows.length >= 2 && blockRows.some((r) => r.cells.length >= 2)) {
          blocks.push(buildTable(blockRows, depth + 1));
        } else if (blockRows.length) {
          blocks.push(blockRows.map((r) => clean(r.text)).join('\n\n'));
        }
      }
      if (blocks.length > 1) return blocks.join('\n\n');
    }
  }

  const tol = 12;
  // Primary: whitespace-projection columns. Fallback: cluster cell-start x's.
  let cols = detectColumns(rows);
  if (cols.length < 2) {
    const clusters: { sum: number; n: number; rows: Set<number> }[] = [];
    rows.forEach((r, ri) =>
      r.cellX.forEach((x) => {
        let c = clusters.find((cl) => Math.abs(cl.sum / cl.n - x) <= tol);
        if (!c) {
          c = { sum: 0, n: 0, rows: new Set() };
          clusters.push(c);
        }
        c.sum += x;
        c.n++;
        c.rows.add(ri);
      }),
    );
    cols = clusters.filter((c) => c.rows.size >= Math.max(2, rows.length * 0.25)).map((c) => c.sum / c.n);
    if (cols.length < 2) cols = clusters.map((c) => c.sum / c.n);
  }
  cols.sort((a, b) => a - b);
  cols = cols.filter((x, i) => i === 0 || x - cols[i - 1] > tol);

  const colOf = (x: number) => {
    let ci = 0;
    for (let k = 0; k < cols.length; k++) {
      if (x >= cols[k] - tol) ci = k;
      else break;
    }
    return ci;
  };

  // Segment text-lines into LOGICAL rows: a new row begins on a first-column
  // token or a large vertical gap; otherwise the line is a wrapped-cell
  // continuation and merges into the current logical row.
  const med = medianGap(rows);
  const logical: Line[][] = [];
  rows.forEach((L, idx) => {
    const hasCol0 = L.toks.some((t) => colOf(t.x) === 0);
    const gap = idx > 0 ? rows[idx - 1].y - L.y : Infinity;
    // Merge only a clear wrapped continuation: no first-column token AND spaced
    // tighter than the table's row rhythm. Distinct rows (even with a sparse
    // first column, e.g. an architecture spec) sit at the normal gap and stay.
    const continuation = idx > 0 && !hasCol0 && med > 0 && gap < med * 0.7;
    if (logical.length === 0 || !continuation) logical.push([L]);
    else logical[logical.length - 1].push(L);
  });

  const matrix = logical.map((group) => {
    const cells = cols.map(() => '');
    // Cluster the row's tokens into baselines (superscripts sit a few points
    // above the line — same baseline, not a separate line), then read each
    // baseline left-to-right. Keeps "1.0 · 10^20" as "1.0 · 10 20" instead of
    // the superscript jumping in front.
    const toks = group.flatMap((l) => l.toks).sort((a, b) => b.y - a.y);
    const baselines: (typeof toks)[] = [];
    for (const t of toks) {
      const last = baselines[baselines.length - 1];
      if (last && Math.abs(last[0].y - t.y) <= Math.max(3, t.size * 0.6)) last.push(t);
      else baselines.push([t]);
    }
    for (const line of baselines) {
      // Gap-gated column transitions: move to a new column only when there is
      // real whitespace at the boundary. Content glued across a boundary is a
      // SPANNING cell (e.g. "3.3 · 10^18" centered under two columns) and
      // stays whole in the column where it started; long labels drifting under
      // the next column stay intact too.
      line.sort((a, b) => a.x - b.x);
      let ci = -1;
      let prev: (typeof line)[number] | null = null;
      for (const t of line) {
        const tCol = colOf(t.x);
        if (ci === -1) {
          ci = tCol;
        } else if (tCol !== ci && prev) {
          const gap = t.x - (prev.x + prev.w);
          if (gap >= Math.max(prev.size, t.size) * 0.5) ci = tCol;
        }
        cells[ci] = cells[ci] ? `${cells[ci]} ${t.str}` : t.str;
        prev = t;
      }
    }
    return cells.map(clean);
  });

  const n = cols.length;

  // Repeated-column-group fold: pages like tax tables print the SAME logical
  // table side by side (3 blocks of 6 columns, identical headers). When a
  // well-populated early row repeats with period p, split into p-column blocks
  // and emit them stacked — that's the human reading order.
  const period = detectRepeatPeriod(matrix, n);
  if (period) {
    const blocks: string[] = [];
    for (let b = 0; b < n / period; b++) {
      const sub = matrix
        .map((r) => r.slice(b * period, (b + 1) * period))
        .filter((r) => r.some((c) => c !== ''));
      if (!sub.length) continue;
      const rowFmt = (r: string[]) => `| ${Array.from({ length: period }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const out = [rowFmt(sub[0]), `| ${Array(period).fill('---').join(' | ')} |`];
      for (const r of sub.slice(1)) out.push(rowFmt(r));
      blocks.push(out.join('\n'));
    }
    return blocks.join('\n\n');
  }

  const row = (r: string[]) => `| ${Array.from({ length: n }, (_, i) => r[i] ?? '').join(' | ')} |`;
  const out = [row(matrix[0]), `| ${Array(n).fill('---').join(' | ')} |`];
  for (const r of matrix.slice(1)) out.push(row(r));
  return out.join('\n');
}

// Find a period p (>=3 columns, >=2 blocks) such that some well-populated row
// among the first few repeats itself across all blocks (normalized equality).
function detectRepeatPeriod(matrix: string[][], n: number): number | null {
  const normCell = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (let p = 3; p <= n / 2; p++) {
    if (n % p !== 0) continue;
    const blocks = n / p;
    for (let r = 0; r < Math.min(4, matrix.length); r++) {
      const row = matrix[r];
      const nonEmpty = row.filter((c) => c !== '').length;
      if (nonEmpty < p * 1.5) continue; // must populate well beyond one block
      let pairs = 0;
      let same = 0;
      for (let i = 0; i < p; i++) {
        for (let b = 1; b < blocks; b++) {
          const a = normCell(row[i] ?? '');
          const c = normCell(row[i + b * p] ?? '');
          if (a || c) {
            pairs++;
            if (a === c) same++;
          }
        }
      }
      if (pairs >= p && same / pairs >= 0.8) return p;
    }
  }
  return null;
}

function classify(groups: Line[][], body: number, levels: Map<number, number>): string[] {
  const blocks: string[] = [];
  for (const lines of groups) {
    let i = 0;
    let para: string[] = [];
    let lastY = NaN;
    // adaptive paragraph break: a gap clearly larger than the group's typical
    // line spacing starts a new paragraph (robust to tight vs loose leading).
    // With enough lines we can infer the group's line spacing and break on a
    // clearly larger gap; with too few lines there's no spacing signal, so use
    // a fixed multiple of the body size.
    const med = medianGap(lines);
    const paraBreak = lines.length >= 5 && med > 0 ? med * 1.5 : body * 1.6;
    const flushPara = () => {
      if (para.length) {
        let s = '';
        for (const ln of para) s = !s ? ln : s.endsWith('-') ? s + ln : `${s} ${ln}`;
        blocks.push(clean(s));
      }
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const lvl = levels.get(line.size);
      // a run of >=2 consecutive multi-cell rows: a real table only if columns
      // align; otherwise it's ragged text and we fall through to prose.
      if (line.cells.length >= 2) {
        const rows: Line[] = [];
        const startX = line.x;
        let lastY = line.y + 1;
        // Extend the region over multi-cell rows AND wrapped-cell continuation
        // lines (single-cell, tightly spaced, indented past the first column).
        while (i < lines.length) {
          const L = lines[i];
          const multi = L.cells.length >= 2;
          const gap = lastY - L.y;
          const cont = !multi && rows.length > 0 && gap >= 0 && gap < L.size * 2.2 && L.x > startX + 8;
          if (!multi && !cont) break;
          rows.push(L);
          lastY = L.y;
          i++;
        }
        if (rows.length >= 2) {
          // a region may contain structurally different sections (forms):
          // segment first, emit each table-worthy segment as its own table
          const segments = segmentByStructure(rows);
          const worthy = segments.map((s) => s.length >= 2 && isAlignedTable(s) && hasTableSubstance(s));
          if (worthy.some(Boolean)) {
            flushPara();
            segments.forEach((seg, k) => {
              if (worthy[k]) blocks.push(buildTable(seg));
              else for (const r of seg) blocks.push(clean(r.text));
            });
            continue;
          }
        }
        i -= rows.length; // not a table — handle each row as ordinary text below
      }
      // headings are short: a long large-font line is emphasised body text, a
      // notice, or an author block — not a section heading.
      if (lvl && q(line.size) >= q(body) + 2 && wordCount(line.text) <= 12 && isHeadingText(line.text) && headingDominates(line)) {
        flushPara();
        blocks.push(`${'#'.repeat(lvl)} ${clean(line.text)}`);
        i++;
        lastY = line.y;
        continue;
      }
      if (BULLET.test(line.text) || ORDERED.test(line.text)) {
        flushPara();
        const items: Line[] = [];
        while (i < lines.length && (BULLET.test(lines[i].text) || ORDERED.test(lines[i].text))) items.push(lines[i++]);
        const baseX = Math.min(...items.map((it) => it.x));
        const list = items.map((it) => {
          const indent = Math.max(0, Math.round((it.x - baseX) / 14));
          const om = it.text.match(ORDERED);
          if (om) return `${'  '.repeat(indent)}${om[1]}. ${clean(it.text.replace(ORDERED, ''))}`;
          return `${'  '.repeat(indent)}- ${clean(it.text.replace(BULLET, ''))}`;
        });
        blocks.push(list.join('\n'));
        continue;
      }
      if (para.length && Number.isFinite(lastY) && lastY - line.y > paraBreak) flushPara();
      para.push(line.text);
      lastY = line.y;
      i++;
    }
    flushPara();
  }
  return blocks;
}

export async function pdf2mdProto(pdfPath: string): Promise<string> {
  const pages = await extractPages(pdfPath);
  const pagesRaw = pages.map(groupRawLines);
  const furniture = findFurniture(pagesRaw);

  // Per page: detect columns, split into reading-order groups.
  const pageGroups: Line[][][] = pagesRaw.map((raw, p) => {
    const toks = pages[p];
    if (!toks.length) return [];
    const minX = Math.min(...toks.map((t) => t.x));
    const maxX = Math.max(...toks.map((t) => t.x + t.w));
    const G = detectGutter(raw, minX, maxX);
    if (G === null) return [raw.map(makeLine)]; // single column: one group, already top->bottom
    return columnize(raw, G, Math.max(14, (maxX - minX) * 0.03));
  });

  const allLines = pageGroups.flat(2).filter((l) => !isNoise(l, furniture));
  const body = bodySizeOf(allLines);
  const levels = headingLevels(allLines, body);

  const blocks: string[] = [];
  for (const groups of pageGroups) {
    const clean = groups.map((g) => g.filter((l) => !isNoise(l, furniture))).filter((g) => g.length);
    blocks.push(...classify(clean, body, levels));
  }

  // Drop the bibliography: a standalone References/Bibliography heading in the
  // back half of the doc, plus everything after it. An agent reading a paper
  // wants the prose, not 100 lines of "[12] Author et al. …". Only fires on
  // docs that actually have such a section (papers) — never on forms/letters.
  const refIdx = blocks.findIndex((b, i) => i > blocks.length * 0.5 && /^#{0,6}\s*(references|bibliography)\s*$/i.test(b.trim()));
  const kept = refIdx >= 0 ? blocks.slice(0, refIdx) : blocks;

  return kept.join('\n\n').trim() + '\n';
}
