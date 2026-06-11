// Deterministic noise benchmark — counts known page-furniture strings
// (running headers/footers, verified by reading the PDFs) that leak into each
// converter's output. Every occurrence beyond `maxAllowed` (legit mentions,
// e.g. an author list) is EXCESS noise. Lower total excess is better; 0 means
// the furniture stripper caught everything. No LLM — the judge's noise dim is
// too coarse (±0.3) to guide this work.
//
//   pnpm run eval:noise
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './paths.ts';
import { resolveConverters } from './converters.ts';

interface NoiseLabel {
  doc: string;
  pattern: string;
  maxAllowed: number;
  note: string;
}

const REAL_PDFS = path.join(EVALS_DIR, 'corpus', 'real', '_pdfs');

function countOccurrences(text: string, pattern: string): number {
  let n = 0;
  let i = text.indexOf(pattern);
  while (i !== -1) {
    n++;
    i = text.indexOf(pattern, i + pattern.length);
  }
  return n;
}

async function main() {
  const labels: NoiseLabel[] = JSON.parse(
    await fs.readFile(path.join(EVALS_DIR, 'corpus', 'noise', 'labels.json'), 'utf8'),
  );
  const docs = [...new Set(labels.map((l) => l.doc))];
  const { available } = await resolveConverters();
  console.log(`› ${labels.length} furniture patterns across ${docs.length} docs · converters: ${available.map((c) => c.id).join(', ')}\n`);

  const outputs: Record<string, Record<string, string>> = {};
  for (const c of available) {
    outputs[c.id] = {};
    for (const d of docs) {
      try {
        outputs[c.id][d] = await c.convert(path.join(REAL_PDFS, `${d}.pdf`));
      } catch {
        outputs[c.id][d] = '';
      }
    }
  }

  const head = ['tool', 'EXCESS', ...labels.map((l) => `${l.doc.slice(0, 10)}:${l.pattern.slice(0, 16)}`)];
  console.log('| ' + head.join(' | ') + ' |');
  console.log('| ' + head.map(() => '---').join(' | ') + ' |');
  const rows = available
    .map((c) => {
      const counts = labels.map((l) => countOccurrences(outputs[c.id][l.doc] || '', l.pattern));
      const excess = labels.reduce((a, l, i) => a + Math.max(0, counts[i] - l.maxAllowed), 0);
      return { id: c.id, excess, counts };
    })
    .sort((a, b) => a.excess - b.excess);
  for (const r of rows) {
    console.log(`| ${r.id} | **${r.excess}** | ${r.counts.join(' | ')} |`);
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
