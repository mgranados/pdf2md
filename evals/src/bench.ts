// Speed benchmark. Wall-clock around the full convert() call — for CLI tools
// that includes process spawn, because that's what an agent actually pays.
import { performance } from 'node:perf_hooks';
import { median, percentile } from './util.ts';

export interface SpeedResult {
  ok: boolean;
  iterations: number;
  medianMs: number;
  minMs: number;
  p95Ms: number;
  pagesPerSec: number;
  error?: string;
  output: string; // last output, reused for quality judging
}

const FAILED = (error: string, output = ''): SpeedResult => ({
  ok: false,
  iterations: 0,
  medianMs: NaN,
  minMs: NaN,
  p95Ms: NaN,
  pagesPerSec: NaN,
  error,
  output,
});

export async function benchConvert(
  convert: (pdf: string) => Promise<string>,
  pdfPath: string,
  pages: number,
  iterations: number,
  warmup = 1,
): Promise<SpeedResult> {
  let output = '';
  try {
    for (let i = 0; i < warmup; i++) output = await convert(pdfPath);
  } catch (e: any) {
    return FAILED(String(e?.message || e));
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      output = await convert(pdfPath);
    } catch (e: any) {
      return FAILED(String(e?.message || e), output);
    }
    times.push(performance.now() - t0);
  }

  const med = median(times);
  return {
    ok: true,
    iterations,
    medianMs: med,
    minMs: Math.min(...times),
    p95Ms: percentile(times, 95),
    pagesPerSec: pages / (med / 1000),
    output,
  };
}
