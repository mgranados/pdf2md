// Regenerates the corpus PDFs + ground-truth markdown from code.
// Deterministic: same source -> same corpus. Run `npm run corpus`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CORPUS_OUT } from './paths.ts';
import { docs, renderPdf } from './corpus.ts';
import { ensureDir } from './util.ts';

export interface EvalDoc {
  id: string;
  corpus: 'synthetic' | 'real';
  mode: 'ground-truth' | 'reference-free';
  description: string;
  pdf: string;
  pages: number;
  bytes: number;
  groundTruth?: string; // path to .gt.md — synthetic (ground-truth) docs only
}

export async function generateCorpus(): Promise<EvalDoc[]> {
  await ensureDir(CORPUS_OUT);
  const manifest: EvalDoc[] = [];
  for (const d of docs) {
    const pdf = await renderPdf(d.build);
    const pdfPath = path.join(CORPUS_OUT, `${d.id}.pdf`);
    const gtPath = path.join(CORPUS_OUT, `${d.id}.gt.md`);
    await fs.writeFile(pdfPath, pdf);
    await fs.writeFile(gtPath, d.groundTruth);
    manifest.push({
      id: d.id,
      corpus: 'synthetic',
      mode: 'ground-truth',
      description: d.description,
      pdf: pdfPath,
      groundTruth: gtPath,
      pages: d.pages,
      bytes: pdf.length,
    });
  }
  await fs.writeFile(path.join(CORPUS_OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Run directly: `node evals/src/generate-corpus.ts`
if (import.meta.filename === process.argv[1]) {
  const m = await generateCorpus();
  for (const e of m) console.log(`✓ ${e.id.padEnd(12)} ${String(e.bytes).padStart(7)} bytes  (${e.description})`);
  console.log(`\nGenerated ${m.length} docs → ${CORPUS_OUT}`);
}
