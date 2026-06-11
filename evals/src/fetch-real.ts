// Fetches the real-world PDFs listed in corpus/real/sources.json into
// corpus/real/_pdfs/ (gitignored). Only URLs live in git, never the PDF bytes
// — so no copyright material is committed. Add your own by editing sources.json
// or just dropping any *.pdf into _pdfs/.  Run: `pnpm run corpus:real`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './paths.ts';
import { ensureDir, pathExists } from './util.ts';

export const REAL_DIR = path.join(EVALS_DIR, 'corpus', 'real');
export const REAL_PDFS = path.join(REAL_DIR, '_pdfs');

interface Source {
  id: string;
  url: string;
  note?: string;
}

export async function fetchReal(): Promise<void> {
  await ensureDir(REAL_PDFS);
  const sources: Source[] = JSON.parse(await fs.readFile(path.join(REAL_DIR, 'sources.json'), 'utf8'));
  for (const s of sources) {
    const dest = path.join(REAL_PDFS, `${s.id}.pdf`);
    if (await pathExists(dest)) {
      console.log(`• ${s.id} — already present, skipping`);
      continue;
    }
    try {
      const res = await fetch(s.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
      await fs.writeFile(dest, buf);
      console.log(`✓ ${s.id} — ${buf.length} bytes`);
    } catch (e: any) {
      console.log(`✖ ${s.id} — fetch failed (${e?.message || e}); skipping`);
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  await fetchReal();
  console.log(`\nReal PDFs in ${REAL_PDFS}`);
}
