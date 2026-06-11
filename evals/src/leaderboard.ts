// Aggregate per-(converter,doc) results into a leaderboard + apply CI gates.
import { DIMENSIONS, type Dimension, type Judgement } from './judge.ts';
import type { SpeedResult } from './bench.ts';
import { mean, round } from './util.ts';

export interface Cell {
  converterId: string;
  docId: string;
  corpus: 'synthetic' | 'real';
  speed: SpeedResult;
  quality?: Judgement;
}

export interface ConverterMeta {
  label: string;
  inProcess: boolean;
}

export interface Row {
  converterId: string;
  label: string;
  inProcess: boolean;
  docs: number;
  failures: number;
  meanMedianMs: number;
  meanPagesPerSec: number;
  worstP95Ms: number;
  composite: number | null; // null when not judged
  dims: Partial<Record<Dimension, number>>;
}

// Headline speed gates, set at the levels the binary actually achieves so a
// regression fails CI (measured 2026-06: ~10ms median on the synthetic corpus,
// ~450 pages/s mean on the 14-doc real corpus; floor is per-char pdfium FFI).
export const SPEED_BUDGET_MS = 25;
export const MIN_PAGES_PER_SEC = 300;
// The whole point — pdf2md must lead on quality once it exists.
export const TARGET_CONVERTER = 'pdf2md';

export function aggregate(cells: Cell[], meta: Record<string, ConverterMeta>): Row[] {
  const byConv = new Map<string, Cell[]>();
  for (const c of cells) {
    if (!byConv.has(c.converterId)) byConv.set(c.converterId, []);
    byConv.get(c.converterId)!.push(c);
  }

  const rows: Row[] = [];
  for (const [converterId, cs] of byConv) {
    const okSpeed = cs.filter((c) => c.speed.ok);
    const judged = cs.filter((c) => c.quality);
    const dims: Partial<Record<Dimension, number>> = {};
    if (judged.length) {
      for (const d of DIMENSIONS) dims[d] = round(mean(judged.map((c) => c.quality!.dims[d])), 1);
    }
    rows.push({
      converterId,
      label: meta[converterId]?.label || converterId,
      inProcess: meta[converterId]?.inProcess ?? false,
      docs: cs.length,
      failures: cs.filter((c) => !c.speed.ok).length,
      meanMedianMs: okSpeed.length ? round(mean(okSpeed.map((c) => c.speed.medianMs)), 1) : NaN,
      meanPagesPerSec: okSpeed.length ? round(mean(okSpeed.map((c) => c.speed.pagesPerSec)), 1) : NaN,
      worstP95Ms: okSpeed.length ? round(Math.max(...okSpeed.map((c) => c.speed.p95Ms)), 1) : NaN,
      composite: judged.length ? round(mean(judged.map((c) => c.quality!.composite)), 2) : null,
      dims,
    });
  }

  // Sort: quality first (desc), then speed (asc). Unjudged rows sort by speed.
  rows.sort((a, b) => {
    const qa = a.composite ?? -1;
    const qb = b.composite ?? -1;
    if (qb !== qa) return qb - qa;
    return a.meanMedianMs - b.meanMedianMs;
  });
  return rows;
}

export function renderTable(rows: Row[], judged: boolean): string {
  const head = judged
    ? '| # | Converter | Quality /10 | text | struct | tables | order | noise | med ms | pages/s | fails |'
    : '| # | Converter | med ms | p95 ms | pages/s | fails |';
  const sep = judged
    ? '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- | --- | --- |';
  const lines = [head, sep];
  rows.forEach((r, i) => {
    const ms = Number.isFinite(r.meanMedianMs) ? r.meanMedianMs : '—';
    const pps = Number.isFinite(r.meanPagesPerSec) ? r.meanPagesPerSec : '—';
    const name = `${r.label}${r.inProcess ? ' *' : ''}`;
    if (judged) {
      lines.push(
        `| ${i + 1} | ${name} | **${r.composite ?? '—'}** | ${r.dims.text_fidelity ?? '—'} | ${r.dims.structure ?? '—'} | ${r.dims.tables ?? '—'} | ${r.dims.reading_order ?? '—'} | ${r.dims.noise ?? '—'} | ${ms} | ${pps} | ${r.failures} |`,
      );
    } else {
      const p95 = Number.isFinite(r.worstP95Ms) ? r.worstP95Ms : '—';
      lines.push(`| ${i + 1} | ${name} | ${ms} | ${p95} | ${pps} | ${r.failures} |`);
    }
  });
  if (rows.some((r) => r.inProcess)) {
    lines.push('');
    lines.push('\\* in-process (no subprocess spawn) — speed not directly comparable to spawned CLI tools; the Rust binary will be timed fairly via `PDF2MD_BIN`.');
  }
  return lines.join('\n');
}

export interface Gate {
  name: string;
  pass: boolean;
  detail: string;
  // indicative gates (e.g. speed vs an in-process impl) are reported but never
  // fail CI — they only become authoritative once the Rust binary is wired.
  indicative?: boolean;
}

// Quality gate bites whenever a pdf2md row is graded (TS reference impl or Rust
// binary). The speed gates are only authoritative once a *spawned* binary is
// timed (PDF2MD_BIN); against the in-process reference impl they're indicative.
// `realRows` (multi-page docs) drives the throughput gate — on 1-page synthetic
// docs pages/s measures spawn cost, not conversion speed.
export function evaluateGates(rows: Row[], realRows: Row[] = []): Gate[] {
  const gates: Gate[] = [];
  const target = rows.find((r) => r.converterId === TARGET_CONVERTER);

  if (!target) {
    gates.push({ name: 'pdf2md graded', pass: false, detail: 'pdf2md produced no result this run' });
    return gates;
  }

  const indicative = target.inProcess ? ' (indicative — in-process; wire PDF2MD_BIN for the real gate)' : '';

  if (target.composite !== null) {
    const leadsQuality = rows[0]?.converterId === TARGET_CONVERTER;
    const runnerUp = rows.find((r) => r.converterId !== TARGET_CONVERTER && r.composite !== null);
    gates.push({
      name: 'pdf2md is #1 on quality',
      pass: leadsQuality,
      detail: leadsQuality
        ? `composite ${target.composite}${runnerUp ? ` vs ${runnerUp.label} ${runnerUp.composite}` : ''}`
        : `beaten by ${rows[0]?.label} (${rows[0]?.composite})`,
    });
  }

  const fastEnough = Number.isFinite(target.meanMedianMs) && target.meanMedianMs < SPEED_BUDGET_MS;
  gates.push({
    name: `pdf2md under ${SPEED_BUDGET_MS}ms median`,
    pass: fastEnough,
    detail: `${target.meanMedianMs}ms median${indicative}`,
    indicative: target.inProcess,
  });

  const realTarget = realRows.find((r) => r.converterId === TARGET_CONVERTER);
  if (realTarget && Number.isFinite(realTarget.meanPagesPerSec)) {
    const throughput = realTarget.meanPagesPerSec >= MIN_PAGES_PER_SEC;
    gates.push({
      name: `pdf2md ≥ ${MIN_PAGES_PER_SEC} pages/s (real corpus)`,
      pass: throughput,
      detail: `${realTarget.meanPagesPerSec} pages/s mean${indicative}`,
      indicative: realTarget.inProcess,
    });
  }

  // Fair comparison: only against other SPAWNED tools. In-process converters
  // (the built-in baselines) pay no subprocess-spawn cost, so timing the
  // spawned binary against them is apples-to-oranges.
  const others = rows.filter(
    (r) => r.converterId !== TARGET_CONVERTER && Number.isFinite(r.meanMedianMs) && !r.inProcess,
  );
  const fastest = others.every((r) => target.meanMedianMs <= r.meanMedianMs);
  gates.push({
    name: 'pdf2md is the fastest (vs spawned tools)',
    pass: fastest,
    detail: (fastest ? `${target.meanMedianMs}ms` : `slower than ${others.find((r) => r.meanMedianMs < target.meanMedianMs)?.label}`) + indicative,
    indicative: target.inProcess,
  });

  return gates;
}
