// Loads the fetched real-world PDFs as eval docs. These have NO ground truth
// (you can't auto-author the correct markdown for an arbitrary paper), so they
// are graded in reference-free mode — see judge.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EvalDoc } from './generate-corpus.ts';
import { REAL_DIR, REAL_PDFS } from './fetch-real.ts';
import { pathExists } from './util.ts';

async function pageCount(pdfPath: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

export async function realCorpus(): Promise<EvalDoc[]> {
  if (!(await pathExists(REAL_PDFS))) return [];
  const notes: Record<string, string> = {};
  try {
    const sources = JSON.parse(await fs.readFile(path.join(REAL_DIR, 'sources.json'), 'utf8'));
    for (const s of sources) notes[s.id] = s.note || '';
  } catch {
    // sources.json optional once PDFs are present
  }

  const files = (await fs.readdir(REAL_PDFS)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const docs: EvalDoc[] = [];
  for (const f of files) {
    const pdf = path.join(REAL_PDFS, f);
    const id = f.replace(/\.pdf$/i, '');
    const { size } = await fs.stat(pdf);
    docs.push({
      id,
      corpus: 'real',
      mode: 'reference-free',
      description: notes[id] || 'real-world PDF',
      pdf,
      pages: await pageCount(pdf),
      bytes: size,
    });
  }
  return docs;
}
