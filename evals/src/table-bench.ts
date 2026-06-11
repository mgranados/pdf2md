// Deterministic table benchmark — GriTS-content-inspired.
//
// Hand-labelled ground-truth grids (corpus/tables/labels.json, verified against
// an independent `pdftotext -layout` extraction) are scored against the pipe
// tables each converter emits: for every labelled grid, find the best-matching
// predicted table + row window, align cells, and score normalized cell-content
// similarity in [0,1]. No LLM anywhere — this exists because the reference-free
// judge's ±0.3 noise can't guide table work.
//
//   pnpm run eval:tables                # score all available converters
//   pnpm run eval:tables -- --show pdf2md   # dump best-match windows for a tool
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './paths.ts';
import { resolveConverters } from './converters.ts';
import { round } from './util.ts';

interface LabelledTable {
  id: string;
  doc: string;
  note: string;
  grid: string[][];
}

const REAL_PDFS = path.join(EVALS_DIR, 'corpus', 'real', '_pdfs');

// ---- markdown table parsing ------------------------------------------------

function parseTables(md: string): string[][][] {
  const tables: string[][][] = [];
  const lines = md.split('\n');
  let cur: string[][] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('|')) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      cur.push(cells);
    } else if (cur.length) {
      tables.push(cur);
      cur = [];
    }
  }
  if (cur.length) tables.push(cur);
  return tables;
}

// ---- similarity -------------------------------------------------------------

// Normalize a cell to its comparable essence: lowercase, unify quotes, keep
// alphanumerics and a little structure, collapse the rest to single spaces.
// "$ 5,428" and "$5,428" -> "5 428"; "2.3 · 10 19" -> "2.3 10 19".
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(?:\s*\.){4,}\s*/g, ' ') // dot leaders
    .replace(/[^a-z0-9.()%†+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}

function cellSim(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ba) {
    total += n;
    inter += Math.min(n, bb.get(g) || 0);
  }
  for (const n of bb.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

// Align two cell rows with classic sequence alignment (gap score 0), return
// the F1-style row similarity: 2*Σsim / (|a| + |b|).
function rowSim(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + cellSim(a[i - 1], b[j - 1]));
    }
  }
  return (2 * dp[n][m]) / (n + m);
}

// Score a labelled grid against one predicted table: best contiguous window of
// rows (positional pairing inside the window), averaged over GT rows.
function gridScore(gt: string[][], pred: string[][]): number {
  if (!pred.length) return 0;
  const r = gt.length;
  let best = 0;
  const maxStart = Math.max(0, pred.length - 1);
  for (let s = 0; s <= maxStart; s++) {
    let sum = 0;
    for (let i = 0; i < r; i++) {
      const p = pred[s + i];
      if (p) sum += rowSim(gt[i], p);
    }
    best = Math.max(best, sum / r);
  }
  return best;
}

export function tableScore(gt: string[][], md: string): { score: number; windowOf?: string[][] } {
  let best = 0;
  let bestTable: string[][] | undefined;
  for (const t of parseTables(md)) {
    const s = gridScore(gt, t);
    if (s > best) {
      best = s;
      bestTable = t;
    }
  }
  return { score: best, windowOf: bestTable };
}

// ---- runner ------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const showIdx = argv.indexOf('--show');
  const show = showIdx >= 0 ? argv[showIdx + 1] : null;

  const labels: LabelledTable[] = JSON.parse(
    await fs.readFile(path.join(EVALS_DIR, 'corpus', 'tables', 'labels.json'), 'utf8'),
  );
  const docs = [...new Set(labels.map((l) => l.doc))];

  const { available } = await resolveConverters();
  console.log(`› ${labels.length} labelled tables across ${docs.length} docs · converters: ${available.map((c) => c.id).join(', ')}\n`);

  // convert each needed doc once per tool
  const outputs: Record<string, Record<string, string>> = {};
  for (const c of available) {
    outputs[c.id] = {};
    for (const d of docs) {
      const pdf = path.join(REAL_PDFS, `${d}.pdf`);
      try {
        outputs[c.id][d] = await c.convert(pdf);
      } catch (e: any) {
        outputs[c.id][d] = '';
        console.log(`  (${c.id} failed on ${d}: ${String(e?.message || e).slice(0, 60)})`);
      }
    }
  }

  const results: Record<string, Record<string, number>> = {};
  for (const c of available) {
    results[c.id] = {};
    for (const l of labels) {
      const { score, windowOf } = tableScore(l.grid, outputs[c.id][l.doc] || '');
      results[c.id][l.id] = score;
      if (show === c.id) {
        console.log(`\n### ${c.id} × ${l.id} → ${round(score, 3)}`);
        for (const row of (windowOf || []).slice(0, l.grid.length + 2)) console.log('  | ' + row.join(' | '));
      }
    }
  }

  // leaderboard
  const rows = available
    .map((c) => {
      const scores = labels.map((l) => results[c.id][l.id]);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      return { id: c.id, mean, scores };
    })
    .sort((a, b) => b.mean - a.mean);

  const head = ['tool', 'MEAN', ...labels.map((l) => l.id.slice(0, 22))];
  console.log('\n| ' + head.join(' | ') + ' |');
  console.log('| ' + head.map(() => '---').join(' | ') + ' |');
  for (const r of rows) {
    console.log(`| ${r.id} | **${round(r.mean, 3)}** | ${r.scores.map((s) => round(s, 3)).join(' | ')} |`);
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
