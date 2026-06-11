// Converter registry. Each rival is a plugin: how to detect it, how to invoke it.
// The only always-available converter is the built-in `naive-pdfjs` baseline
// (pure-JS text dump) so the full pipeline runs with zero external installs.
// Rivals that aren't installed are reported as "skipped", never silently dropped.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pdf2mdProto } from './pdf2md-proto.ts';

const execFileP = promisify(execFile);

export interface Converter {
  id: string;
  label: string;
  installHint: string;
  available: () => Promise<boolean>;
  convert: (pdfPath: string) => Promise<string>;
  // true = runs in-process (no subprocess spawn), so its speed is NOT directly
  // comparable to spawned CLI rivals. Flagged in the leaderboard.
  inProcess?: boolean;
}

async function binExists(bin: string): Promise<boolean> {
  try {
    await execFileP('sh', ['-c', `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pdf2md-eval-'));
}

async function firstMarkdownIn(dir: string): Promise<string> {
  const walk = async (d: string): Promise<string[]> => {
    const ents = await fs.readdir(d, { withFileTypes: true });
    const files: string[] = [];
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) files.push(...(await walk(full)));
      else if (e.name.toLowerCase().endsWith('.md')) files.push(full);
    }
    return files;
  };
  const mds = await walk(dir);
  if (mds.length === 0) throw new Error(`no .md produced in ${dir}`);
  return fs.readFile(mds[0], 'utf8');
}

// --- built-in baseline: pure-JS text dump via pdfjs-dist -------------------
// Deliberately dumb: walks text runs, breaks lines on vertical gaps. No heading
// detection, no column awareness, no tables. This is the "fast-but-dumb" floor
// every structure-aware tool must beat.
export async function naivePdfjs(pdfPath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let line = '';
    let lastY: number | null = null;
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
      line += item.str + (item.hasEOL ? '' : ' ');
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const CONVERTERS: Converter[] = [
  {
    id: 'naive-pdfjs',
    label: 'naive-pdfjs (built-in baseline)',
    installHint: 'built in',
    available: async () => true,
    convert: naivePdfjs,
    inProcess: true,
  },
  {
    id: 'pdftotext',
    label: 'pdftotext -layout (poppler)',
    installHint: 'brew install poppler',
    available: () => binExists('pdftotext'),
    convert: (pdf) => run('pdftotext', ['-layout', pdf, '-']),
  },
  {
    id: 'markitdown',
    label: 'markitdown (Microsoft)',
    installHint: "pipx install 'markitdown[pdf]'",
    available: () => binExists('markitdown'),
    convert: (pdf) => run('markitdown', [pdf]),
  },
  {
    // The closest existing "PDF -> Markdown for LLMs" library (PyMuPDF-based
    // heuristics) — the honest head-to-head for pdf2md's whole premise.
    id: 'pymupdf4llm',
    label: 'pymupdf4llm (PyMuPDF)',
    installHint: "python3 -m venv ~/.venvs/pdf2md-rivals && ~/.venvs/pdf2md-rivals/bin/pip install pymupdf4llm",
    available: () => binExists(`${process.env.HOME}/.venvs/pdf2md-rivals/bin/python`),
    convert: (pdf) =>
      run(`${process.env.HOME}/.venvs/pdf2md-rivals/bin/python`, [
        '-c',
        'import pymupdf4llm,sys;print(pymupdf4llm.to_markdown(sys.argv[1]))',
        pdf,
      ], 600_000),
  },
  {
    id: 'docling',
    label: 'docling (IBM)',
    installHint: 'pipx install docling',
    available: () => binExists('docling'),
    convert: async (pdf) => {
      const out = await tmpDir();
      await run('docling', ['--to', 'md', '--output', out, pdf]);
      return firstMarkdownIn(out);
    },
  },
  {
    id: 'marker',
    label: 'marker (datalab)',
    installHint: 'pipx install marker-pdf',
    available: () => binExists('marker_single'),
    convert: async (pdf) => {
      const out = await tmpDir();
      await run('marker_single', [pdf, '--output_dir', out], 600_000);
      return firstMarkdownIn(out);
    },
  },
  {
    // The shippable target. Uses the Rust binary when PDF2MD_BIN points at one
    // (spawned, fair speed); otherwise falls back to the in-process TS reference
    // implementation of the same heuristics so the converter is always graded.
    id: 'pdf2md',
    label: process.env.PDF2MD_BIN ? 'pdf2md (Rust binary)' : 'pdf2md (TS reference impl)',
    installHint: 'cargo build --release && PDF2MD_BIN=./target/release/pdf2md  (Rust port pending)',
    available: async () => (process.env.PDF2MD_BIN ? binExists(process.env.PDF2MD_BIN) : true),
    convert: (pdf) =>
      process.env.PDF2MD_BIN ? run(process.env.PDF2MD_BIN, [pdf, '--stdout']) : pdf2mdProto(pdf),
    inProcess: !process.env.PDF2MD_BIN,
  },
];

export async function resolveConverters(filter?: string[]): Promise<{ available: Converter[]; skipped: Converter[] }> {
  const available: Converter[] = [];
  const skipped: Converter[] = [];
  for (const c of CONVERTERS) {
    if (filter && filter.length > 0 && !filter.includes(c.id)) continue;
    if (await c.available()) available.push(c);
    else skipped.push(c);
  }
  return { available, skipped };
}
