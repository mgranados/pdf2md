// Deterministic text-fidelity benchmark.
//
// Two signals, no LLM:
// 1. PASSAGES — hand-verified sentences from the real PDFs (corpus/text/
//    labels.json) must survive in the output. Comparison is normalized
//    (lowercase, alphanumerics only) so hyphenation/spacing choices don't
//    matter — what's tested is completeness, order, and char-level garbling:
//    a dropped, duplicated, or scrambled word breaks the match.
// 2. BROKEN-WORD RATE — fraction of alphabetic tokens not in the system
//    dictionary, compared RELATIVE across tools on the same docs. A tool with
//    a higher rate than its peers is garbling words (bad de-hyphenation,
//    merged/split words). Absolute rates are dominated by names/jargon and
//    mean little; the spread is the signal.
//
//   pnpm run eval:text
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './paths.ts';
import { resolveConverters } from './converters.ts';
import { round } from './util.ts';

interface PassageLabel {
  doc: string;
  passage: string;
}

const REAL_PDFS = path.join(EVALS_DIR, 'corpus', 'real', '_pdfs');

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

async function loadDict(): Promise<Set<string>> {
  try {
    const words = await fs.readFile('/usr/share/dict/words', 'utf8');
    return new Set(words.split('\n').map((w) => w.toLowerCase()));
  } catch {
    return new Set();
  }
}

function brokenWordRate(text: string, dict: Set<string>): number {
  const tokens = text.toLowerCase().match(/[a-z]{2,}/g) || [];
  if (!tokens.length || !dict.size) return 0;
  let oov = 0;
  for (const t of tokens) if (!dict.has(t)) oov++;
  return oov / tokens.length;
}

async function main() {
  const labels: PassageLabel[] = JSON.parse(
    await fs.readFile(path.join(EVALS_DIR, 'corpus', 'text', 'labels.json'), 'utf8'),
  );
  const docs = [...new Set(labels.map((l) => l.doc))];
  const dict = await loadDict();
  const { available } = await resolveConverters();
  console.log(`› ${labels.length} passages across ${docs.length} docs · dict ${dict.size} words · converters: ${available.map((c) => c.id).join(', ')}\n`);

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

  const rows = available
    .map((c) => {
      let found = 0;
      const misses: string[] = [];
      for (const l of labels) {
        const hay = normalize(outputs[c.id][l.doc] || '');
        if (hay.includes(normalize(l.passage))) found++;
        else misses.push(`${l.doc}: "${l.passage.slice(0, 50)}…"`);
      }
      const rates = docs.map((d) => brokenWordRate(outputs[c.id][d] || '', dict));
      const oov = rates.reduce((a, b) => a + b, 0) / rates.length;
      return { id: c.id, found, misses, oov };
    })
    .sort((a, b) => b.found - a.found || a.oov - b.oov);

  console.log('| tool | passages intact | broken-word rate |');
  console.log('| --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.id} | **${r.found}/${labels.length}** | ${round(r.oov * 100, 2)}% |`);
  for (const r of rows) {
    if (r.misses.length && r.misses.length < labels.length) {
      console.log(`\n${r.id} missing:`);
      for (const m of r.misses) console.log(`  ✗ ${m}`);
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
