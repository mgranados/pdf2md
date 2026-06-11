// Quality judge — LLM-as-grader via the `claude` CLI (NOT the API).
//
// Why the CLI: with no ANTHROPIC_API_KEY set, `claude` uses your subscription,
// so grading draws subscription quota instead of metered API tokens. We hard-
// guard against an API key being present so a stray key can't silently start
// billing. Results are cached by content hash so re-runs cost nothing and the
// benchmark is reproducible.
//
// Two modes:
//   ground-truth   — synthetic corpus; compare candidate to the exact answer.
//   reference-free — real-world PDFs (no ground truth); judge intrinsic quality
//                    with a char-count completeness signal.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CACHE_DIR } from './paths.ts';
import { ensureDir, sha256 } from './util.ts';

const execFileP = promisify(execFile);

// Bump to invalidate cached judgements when a rubric changes. Versioned per
// mode so changing one doesn't needlessly re-run the other.
export const RUBRIC_VERSION = 'v2'; // ground-truth
export const REF_FREE_VERSION = 'v3'; // reference-free

export const DIMENSIONS = ['text_fidelity', 'structure', 'tables', 'reading_order', 'noise'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// Composite weighting. Text fidelity dominates (a converter that drops/garbles
// text is useless to an agent); structure and reading order are the next prize.
export const WEIGHTS: Record<Dimension, number> = {
  text_fidelity: 0.35,
  structure: 0.25,
  reading_order: 0.2,
  tables: 0.15,
  noise: 0.05,
};

export type JudgeMode = 'ground-truth' | 'reference-free';

export interface Signals {
  pages: number;
  sourceChars: number;
  candidateChars: number;
}

export interface Judgement {
  dims: Record<Dimension, number>;
  composite: number; // 0-10
  notes: string;
  cached: boolean;
}

const RUBRIC = `You are a HARSH grader for a competitive PDF-to-Markdown conversion benchmark.
You are given the GROUND TRUTH markdown (the exact correct conversion) and a CANDIDATE conversion produced by some tool. Score how faithfully the candidate reproduces the ground truth. Tools are competing for the top of a leaderboard, so be discriminating: do NOT cluster everything at 8-10.

Anchoring rules (apply strictly):
- 10 means information- and structure-equivalent to the ground truth. Award it rarely.
- A flat text dump that contains the right WORDS but no markdown structure (no #/##/### headings, lists not as "-"/"1.", tables as loose text) must score 2-4 on structure, NOT higher.
- If the ground truth has a table and the candidate did NOT emit a GitHub pipe table (\`| ... |\`), tables must be <= 3.
- If multi-column text is interleaved/zigzagged so sentences are broken across columns, reading_order must be <= 3.
- If page furniture (page numbers, repeated running headers/footers) is present in the candidate but absent from ground truth, noise must be <= 4.
When uncertain, score LOWER.

Score each dimension as an integer 0-10:
- text_fidelity: is ALL body text present, accurate, and free of garbling, duplication, dropped words, or broken ligatures?
- structure: headings at correct levels (# / ## / ###), paragraphs joined (not one line per wrap), lists as "-"/"1." with correct nesting.
- tables: tables reconstructed faithfully as GitHub pipe tables (correct rows, columns, cells)? If the ground truth contains NO table, score 10.
- reading_order: content in correct human reading order; columns emitted whole, never interleaved.
- noise: free of page numbers, repeated headers/footers, stray characters, or layout whitespace dumped as text. 10 = clean.

Output ONLY a single JSON object and nothing else (no prose, no code fences):
{"text_fidelity":N,"structure":N,"tables":N,"reading_order":N,"noise":N,"notes":"one short sentence"}`;

// Real-world PDFs have no ground truth, so we judge intrinsic quality with a
// char-count completeness signal instead of a reference document.
const REF_FREE_RUBRIC = `You are a HARSH grader for a competitive PDF-to-Markdown benchmark.
There is NO ground truth for this document (a real-world PDF). Judge the CANDIDATE markdown on its INTRINSIC quality as a faithful, clean markdown rendering. Be discriminating; do NOT cluster at 8-10.

You are given the source PDF's page count and raw text-layer size, and the candidate's size, as a completeness signal.

Score each dimension 0-10:
- text_fidelity: prose reads as complete, coherent, correctly-spelled text — no garbling, broken words/ligatures, or duplication. A LOWER char ratio is EXPECTED and GOOD when the candidate correctly omits page furniture (headers/footers/page numbers) and the bibliography/references list — do NOT penalize that. Only penalize if actual body prose is missing or truncated mid-sentence/mid-section. Wildly MORE chars than the source => junk dumped (low).
- structure: headings (#/##/###), paragraphs and lists present and plausible (not a wall of text, not one-line-per-wrap).
- tables: tabular data rendered as GitHub pipe tables. Column-like data dumped as loose text => low. If the doc plausibly has no tables, score 8-10.
- reading_order: prose flows correctly. Interleaved two-column text reads as broken/incoherent sentences => low.
- noise: free of page numbers, running headers/footers, reference clutter, and layout whitespace dumped as text. 10 = clean.
When uncertain, score LOWER.

Output ONLY a single JSON object: {"text_fidelity":N,"structure":N,"tables":N,"reading_order":N,"noise":N,"notes":"one short sentence"}`;

const CANDIDATE_CAP = 14_000;

function clip(s: string): string {
  if (s.length <= CANDIDATE_CAP) return s;
  return `${s.slice(0, CANDIDATE_CAP)}\n\n…[truncated for judging; ${s.length} chars total]`;
}

function buildGroundTruthPrompt(reference: string, candidate: string): string {
  return `${RUBRIC}

=== GROUND TRUTH ===
${reference}

=== CANDIDATE ===
${candidate}`;
}

function buildRefFreePrompt(candidate: string, sig: Signals): string {
  const ratio = sig.sourceChars ? Math.round((sig.candidateChars / sig.sourceChars) * 100) : 0;
  return `${REF_FREE_RUBRIC}

Source: ${sig.pages} pages, raw text layer ≈ ${sig.sourceChars} chars.
Candidate: ${sig.candidateChars} chars (${ratio}% of the raw text layer).

=== CANDIDATE (may be truncated) ===
${clip(candidate)}`;
}

function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON object in judge output: ${text.slice(0, 300)}`);
  return JSON.parse(body.slice(start, end + 1));
}

function composite(dims: Record<Dimension, number>): number {
  let sum = 0;
  for (const d of DIMENSIONS) sum += (dims[d] ?? 0) * WEIGHTS[d];
  return Math.round(sum * 100) / 100;
}

export interface JudgeOptions {
  model?: string;
  allowApi?: boolean;
  noCache?: boolean;
  mode?: JudgeMode;
  signals?: Signals; // required for reference-free
}

export function assertNoApiBilling(allowApi: boolean): void {
  if (process.env.ANTHROPIC_API_KEY && !allowApi) {
    throw new Error(
      'ANTHROPIC_API_KEY is set — the claude CLI would bill API tokens. ' +
        'This benchmark grades via your subscription on purpose. ' +
        'Unset the key (recommended) or pass --allow-api to override.',
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callClaudeOnce(prompt: string, model: string): Promise<string> {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--strict-mcp-config'];
  // input:'' closes stdin so the CLI doesn't wait on piped data.
  const { stdout } = await execFileP('claude', args, {
    input: '',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const env = JSON.parse(stdout);
  if (env.is_error) throw new Error(`claude reported an error: ${env.subtype || ''} ${env.result || ''}`);
  if (typeof env.result !== 'string') throw new Error('unexpected claude envelope (no string result)');
  return env.result;
}

// Retry transient CLI failures (rate limits, overload) with backoff.
async function callClaude(prompt: string, model: string): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      return await callClaudeOnce(prompt, model);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function judge(reference: string, candidate: string, opts: JudgeOptions = {}): Promise<Judgement> {
  const model = opts.model || 'sonnet';
  const mode: JudgeMode = opts.mode || 'ground-truth';

  // Ground-truth keys keep the original format so existing cache survives.
  const key =
    mode === 'ground-truth'
      ? sha256([RUBRIC_VERSION, model, reference, candidate].join(' '))
      : sha256([REF_FREE_VERSION, model, 'reffree', JSON.stringify(opts.signals || {}), candidate].join(' '));
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  if (!opts.noCache) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      return { ...cached, cached: true };
    } catch {
      // miss
    }
  }

  assertNoApiBilling(!!opts.allowApi);

  const prompt =
    mode === 'ground-truth'
      ? buildGroundTruthPrompt(reference, candidate)
      : buildRefFreePrompt(candidate, opts.signals || { pages: 0, sourceChars: 0, candidateChars: candidate.length });

  const raw = await callClaude(prompt, model);
  const parsed = extractJson(raw);
  const dims = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) {
    const v = Number(parsed[d]);
    dims[d] = Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v))) : 0;
  }
  const result = { dims, composite: composite(dims), notes: String(parsed.notes ?? '') };

  await ensureDir(CACHE_DIR);
  await fs.writeFile(cacheFile, JSON.stringify(result, null, 2));
  return { ...result, cached: false };
}
