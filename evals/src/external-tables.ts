// EXTERNAL table validation — ground truth we did not create.
//
// The Tabula project (tabulapdf/tabula-java) ships PDF + expected-CSV pairs
// hand-made by its maintainers for testing their own extractor. Scoring every
// converter against THEIR ground truth with our usual GriTS-content scorer
// answers the self-labelled-benchmark concern: nobody on this project authored
// these answers. Files are fetched at runtime (never committed).
//
//   pnpm run eval:tables-external
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './paths.ts';
import { resolveConverters } from './converters.ts';
import { tableScore } from './table-bench.ts';
import { ensureDir, pathExists, round } from './util.ts';

const BASE = 'https://raw.githubusercontent.com/tabulapdf/tabula-java/master/src/test/resources/technology/tabula';
const PAIRS = [
  'AnimalSounds',
  'MultiColumn',
  'Publication_of_award_of_Bids_for_Transport_Sector__August_2016',
  'argentina_diputados_voting_record',
  'frx_2012_disclosure',
  'indictb1h_14',
  'schools',
  'spanning_cells',
  'spreadsheet_no_bounding_frame',
  'twotables',
  'us-020',
];

const DIR = path.join(EVALS_DIR, 'corpus', 'external', '_files');

async function fetchPairs(): Promise<string[]> {
  await ensureDir(DIR);
  const ok: string[] = [];
  for (const id of PAIRS) {
    const pdf = path.join(DIR, `${id}.pdf`);
    const csv = path.join(DIR, `${id}.csv`);
    try {
      if (!(await pathExists(pdf))) {
        const r = await fetch(`${BASE}/${id}.pdf`, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`pdf HTTP ${r.status}`);
        await fs.writeFile(pdf, Buffer.from(await r.arrayBuffer()));
      }
      if (!(await pathExists(csv))) {
        const r = await fetch(`${BASE}/csv/${id}.csv`, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`csv HTTP ${r.status}`);
        await fs.writeFile(csv, Buffer.from(await r.arrayBuffer()));
      }
      ok.push(id);
    } catch (e: any) {
      console.log(`  (skip ${id}: ${String(e?.message || e).slice(0, 60)})`);
    }
  }
  return ok;
}

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/newlines).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

async function main() {
  console.log('› fetching Tabula test pairs (external ground truth)…');
  const ids = await fetchPairs();
  const { available } = await resolveConverters();
  console.log(`› ${ids.length} external tables · converters: ${available.map((c) => c.id).join(', ')}\n`);

  const grids: Record<string, string[][]> = {};
  for (const id of ids) {
    grids[id] = parseCsv(await fs.readFile(path.join(DIR, `${id}.csv`), 'utf8'));
  }

  const rows = [];
  for (const c of available) {
    const scores: number[] = [];
    for (const id of ids) {
      let md = '';
      try {
        md = await c.convert(path.join(DIR, `${id}.pdf`));
      } catch {
        // failed conversion scores 0
      }
      scores.push(tableScore(grids[id], md).score);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    rows.push({ id: c.id, mean, scores });
  }
  rows.sort((a, b) => b.mean - a.mean);

  const head = ['tool', 'MEAN', ...ids.map((i) => i.slice(0, 14))];
  console.log('| ' + head.join(' | ') + ' |');
  console.log('| ' + head.map(() => '---').join(' | ') + ' |');
  for (const r of rows) {
    console.log(`| ${r.id} | **${round(r.mean, 3)}** | ${r.scores.map((s) => round(s, 2)).join(' | ')} |`);
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
