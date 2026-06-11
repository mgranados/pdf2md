// Orchestrator: build corpora -> resolve converters -> bench speed ->
// judge quality (via claude CLI) -> two leaderboards + CI gates.
//
//   node evals/src/run.ts                 full eval (speed + quality)
//   node evals/src/run.ts --bench-only    speed only (no claude calls)
//   node evals/src/run.ts --judge-only    quality only (1 conversion each)
//   flags: --iterations N  --model sonnet  --converters a,b  --no-cache
//          --allow-api  --synthetic-only  --real-only
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateCorpus, type EvalDoc } from './generate-corpus.ts';
import { realCorpus } from './real-corpus.ts';
import { resolveConverters, naivePdfjs } from './converters.ts';
import { benchConvert } from './bench.ts';
import { judge, assertNoApiBilling, type Signals } from './judge.ts';
import { aggregate, renderTable, evaluateGates, type Cell, type ConverterMeta, type Row } from './leaderboard.ts';
import { RESULTS_DIR } from './paths.ts';
import { ensureDir } from './util.ts';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const benchOnly = has('--bench-only');
const judgeOnly = has('--judge-only');
const noCache = has('--no-cache');
const allowApi = has('--allow-api');
const model = val('--model', 'sonnet');
const iterations = judgeOnly ? 1 : parseInt(val('--iterations', '5'), 10);
const filter = has('--converters') ? val('--converters', '').split(',').filter(Boolean) : undefined;

function pct(n: number) {
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

function rankingLine(rows: Row[]): string {
  return rows
    .filter((r) => r.composite !== null)
    .map((r) => `${r.converterId} ${r.composite}`)
    .join(' > ');
}

async function main() {
  if (!benchOnly) assertNoApiBilling(allowApi);

  console.log('› building corpora…');
  const synthetic = has('--real-only') ? [] : await generateCorpus();
  const real = has('--synthetic-only') ? [] : await realCorpus();
  const docs: EvalDoc[] = [...synthetic, ...real];
  console.log(`› ${synthetic.length} synthetic (ground-truth) + ${real.length} real (reference-free) docs`);

  const { available, skipped } = await resolveConverters(filter);
  const meta: Record<string, ConverterMeta> = {};
  for (const c of [...available, ...skipped]) meta[c.id] = { label: c.label, inProcess: !!c.inProcess };
  console.log(`› converters: ${available.map((c) => c.id).join(', ') || '(none)'}`);
  if (skipped.length) console.log(`› skipped (not installed): ${skipped.map((c) => c.id).join(', ')}`);
  console.log(`› mode: ${benchOnly ? 'speed only' : judgeOnly ? 'quality only' : 'speed + quality'} · iterations=${iterations} · model=${model}\n`);

  // Reference-free judging needs the raw text-layer size per real doc.
  const sourceChars: Record<string, number> = {};
  if (!benchOnly) {
    for (const d of real) sourceChars[d.id] = (await naivePdfjs(d.pdf)).length;
  }

  const cells: Cell[] = [];
  for (const c of available) {
    for (const doc of docs) {
      process.stdout.write(`  ${c.id} × ${doc.id} … `);
      const speed = await benchConvert(c.convert, doc.pdf, doc.pages, iterations);
      const cell: Cell = { converterId: c.id, docId: doc.id, corpus: doc.corpus, speed };
      if (!speed.ok) {
        console.log(`FAILED (${speed.error?.slice(0, 80)})`);
        cells.push(cell);
        continue;
      }
      let q = '';
      if (!benchOnly) {
        try {
          if (doc.mode === 'ground-truth') {
            const gt = await fs.readFile(doc.groundTruth!, 'utf8');
            cell.quality = await judge(gt, speed.output, { model, allowApi, noCache, mode: 'ground-truth' });
          } else {
            const signals: Signals = { pages: doc.pages, sourceChars: sourceChars[doc.id] || 0, candidateChars: speed.output.length };
            cell.quality = await judge('', speed.output, { model, allowApi, noCache, mode: 'reference-free', signals });
          }
          q = ` · quality ${cell.quality.composite}${cell.quality.cached ? ' (cached)' : ''}`;
        } catch (e: any) {
          // A flaky judge call must not sink the whole run; record no score.
          q = ` · judge FAILED (${String(e?.message || e).slice(0, 50)})`;
        }
      }
      console.log(`${pct(speed.medianMs)}ms${q}`);
      cells.push(cell);
    }
  }

  const judged = !benchOnly;
  const synthRows = aggregate(cells.filter((c) => c.corpus === 'synthetic'), meta);
  const realRows = aggregate(cells.filter((c) => c.corpus === 'real'), meta);
  const gates = synthRows.length ? evaluateGates(synthRows, realRows) : [];

  // Artifacts.
  await ensureDir(RESULTS_DIR);
  const md = [
    '# pdf2md eval — leaderboard',
    '',
    `Synthetic (ground-truth): ${synthetic.length} docs · Real (reference-free): ${real.length} docs · iterations: ${iterations} · judge: ${model}`,
    '',
    ...(synthRows.length ? ['## Ground-truth corpus (synthetic, exact answers)', '', renderTable(synthRows, judged), ''] : []),
    ...(synthRows.length ? ['### Gates', '', ...gates.map((g) => `- ${g.indicative ? '◌' : g.pass ? '✅' : '⛔'} **${g.name}** — ${g.detail}`), ''] : []),
    ...(realRows.length ? ['## Real-world corpus (reference-free — no ground truth, intrinsic quality)', '', renderTable(realRows, judged), '', `Ranking: ${rankingLine(realRows)}`, ''] : []),
    skipped.length ? '## Not installed (install to include)\n' : '',
    ...skipped.map((c) => `- \`${c.id}\` — ${c.installHint}`),
    '',
  ].join('\n');
  await fs.writeFile(path.join(RESULTS_DIR, 'leaderboard.md'), md);
  await fs.writeFile(path.join(RESULTS_DIR, 'results.json'), JSON.stringify({ model, iterations, synthRows, realRows, gates, cells }, null, 2));

  if (synthRows.length) {
    console.log('\nGround-truth corpus:');
    console.log(renderTable(synthRows, judged));
    console.log('\nGates:');
    for (const g of gates) console.log(`  ${g.indicative ? '◌' : g.pass ? '✅' : '⛔'} ${g.name} — ${g.detail}`);
  }
  if (realRows.length) {
    console.log('\nReal-world corpus (reference-free):');
    console.log(renderTable(realRows, judged));
    console.log(`Ranking: ${rankingLine(realRows)}`);
  }
  if (skipped.length) {
    console.log('\nInstall to broaden the field:');
    for (const c of skipped) console.log(`  ${c.id.padEnd(12)} ${c.installHint}`);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), path.join(RESULTS_DIR, 'leaderboard.md'))}`);

  // CI exit code: fail only on authoritative (non-indicative) ground-truth gate failures.
  const targetPresent = synthRows.some((r) => r.converterId === 'pdf2md');
  const failed = gates.some((g) => !g.pass && !g.indicative);
  if (targetPresent && failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n✖', e?.message || e);
  process.exitCode = 1;
});
