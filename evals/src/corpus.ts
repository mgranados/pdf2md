// Synthetic, reproducible corpus.
//
// Each doc is a born-digital PDF *built from code*, so the ground-truth markdown
// is exact and co-located — no manual labelling, no binary blobs in git. We
// author adversarial layouts (heading hierarchy, nested lists, genuinely
// scrambling columns, grid tables, running headers/footers) precisely because
// that is where fast-but-dumb extraction fails and where structure
// reconstruction earns its keep.
import PDFDocument from 'pdfkit';

export interface CorpusDoc {
  id: string;
  description: string;
  pages: number;
  build: (doc: any) => void;
  groundTruth: string;
}

const BODY = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SIZE = { h1: 22, h2: 15, h3: 12.5, body: 11 };

function h(doc: any, level: 1 | 2 | 3, t: string) {
  const size = level === 1 ? SIZE.h1 : level === 2 ? SIZE.h2 : SIZE.h3;
  doc.font(BOLD).fontSize(size).text(t).moveDown(0.35);
}
function para(doc: any, t: string, opts: any = {}) {
  doc.font(BODY).fontSize(SIZE.body).text(t, opts).moveDown(0.9);
}
function bullets(doc: any, items: Array<[number, string]>) {
  doc.font(BODY).fontSize(SIZE.body);
  for (const [depth, t] of items) doc.text(`• ${t}`, { indent: depth * 16 });
  doc.moveDown(0.4);
}
function ordered(doc: any, items: string[]) {
  doc.font(BODY).fontSize(SIZE.body);
  items.forEach((t, i) => doc.text(`${i + 1}. ${t}`));
  doc.moveDown(0.4);
}

export const docs: CorpusDoc[] = [
  {
    id: 'simple',
    description: 'H1 + paragraphs + H2 + bullet list. The easy floor — everyone should pass.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Quarterly Notes');
      para(doc, 'This document records the headline outcomes for the quarter. It is a plain, single-column PDF with a real text layer.');
      h(doc, 2, 'Highlights');
      para(doc, 'Revenue grew steadily and churn fell for the third month running.');
      bullets(doc, [[0, 'Signed two new pilot customers'], [0, 'Shipped the export feature'], [0, 'Cut p95 latency in half']]);
    },
    groundTruth: [
      '# Quarterly Notes',
      '',
      'This document records the headline outcomes for the quarter. It is a plain, single-column PDF with a real text layer.',
      '',
      '## Highlights',
      '',
      'Revenue grew steadily and churn fell for the third month running.',
      '',
      '- Signed two new pilot customers',
      '- Shipped the export feature',
      '- Cut p95 latency in half',
      '',
    ].join('\n'),
  },

  {
    id: 'deep-structure',
    description: 'H1/H2/H3 hierarchy + nested bullets + an ordered list. Tests heading levels and nesting.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Project Atlas');
      para(doc, 'Atlas is a small tool with a deliberately layered document structure.');
      h(doc, 2, 'Goals');
      bullets(doc, [
        [0, 'Be fast'],
        [0, 'Be correct'],
        [1, 'no data loss'],
        [1, 'no scrambling'],
        [0, 'Be small'],
      ]);
      h(doc, 2, 'Milestones');
      h(doc, 3, 'Phase one');
      para(doc, 'Ship the parser.');
      ordered(doc, ['Tokenise', 'Group lines into rows', 'Emit markdown']);
    },
    groundTruth: [
      '# Project Atlas',
      '',
      'Atlas is a small tool with a deliberately layered document structure.',
      '',
      '## Goals',
      '',
      '- Be fast',
      '- Be correct',
      '  - no data loss',
      '  - no scrambling',
      '- Be small',
      '',
      '## Milestones',
      '',
      '### Phase one',
      '',
      'Ship the parser.',
      '',
      '1. Tokenise',
      '2. Group lines into rows',
      '3. Emit markdown',
      '',
    ].join('\n'),
  },

  {
    id: 'two-column',
    description: 'Two columns drawn row-by-row at matching Y, so naive readers interleave them. Tests reading order.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'On Reading Order');
      const left = [
        'Multi-column layouts are where',
        'naive extraction breaks. A tool',
        'that walks runs by vertical',
        'position will zigzag between the',
        'two columns and scramble the',
        'prose into nonsense.',
      ];
      const right = [
        'A structure-aware converter finds',
        'the column boundary from the gap',
        'and emits whole columns in human',
        'reading order. This paragraph',
        'belongs entirely after the left',
        'column, never interleaved.',
      ];
      const top = doc.y;
      const xL = 56;
      const xR = 320;
      const lineH = 13;
      doc.font(BODY).fontSize(SIZE.body);
      // Draw row by row at the SAME y -> a y-sorted reader merges L+R per row.
      for (let i = 0; i < left.length; i++) {
        const y = top + i * lineH;
        doc.text(left[i], xL, y, { lineBreak: false });
        doc.text(right[i], xR, y, { lineBreak: false });
      }
    },
    groundTruth: [
      '# On Reading Order',
      '',
      'Multi-column layouts are where naive extraction breaks. A tool that walks runs by vertical position will zigzag between the two columns and scramble the prose into nonsense.',
      '',
      'A structure-aware converter finds the column boundary from the gap and emits whole columns in human reading order. This paragraph belongs entirely after the left column, never interleaved.',
      '',
    ].join('\n'),
  },

  {
    id: 'table',
    description: 'A 4-column grid table with multi-word cells. Tests reconstruction into GFM pipe syntax.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Plan Comparison');
      para(doc, 'The plans differ in limits and price.');
      const rows = [
        ['Plan', 'Seats', 'Storage', 'Price'],
        ['Solo', '1', '5 GB', '$0'],
        ['Team', '10', '100 GB', '$49'],
        ['Scale', '50', '1 TB', '$199'],
      ];
      const startX = 56;
      const colW = [120, 90, 110, 90];
      let y = doc.y + 6;
      const rowH = 22;
      doc.fontSize(SIZE.body);
      rows.forEach((row, r) => {
        let x = startX;
        row.forEach((cell, c) => {
          doc.font(r === 0 ? BOLD : BODY).text(cell, x + 6, y + 5, { width: colW[c] - 12, lineBreak: false });
          x += colW[c];
        });
        const tot = colW.reduce((a, b) => a + b, 0);
        doc.moveTo(startX, y + rowH).lineTo(startX + tot, y + rowH).strokeColor('#999').lineWidth(0.5).stroke();
        y += rowH;
      });
    },
    groundTruth: [
      '# Plan Comparison',
      '',
      'The plans differ in limits and price.',
      '',
      '| Plan | Seats | Storage | Price |',
      '| --- | --- | --- | --- |',
      '| Solo | 1 | 5 GB | $0 |',
      '| Team | 10 | 100 GB | $49 |',
      '| Scale | 50 | 1 TB | $199 |',
      '',
    ].join('\n'),
  },

  {
    id: 'noisy',
    description: '2 pages with a running header + footer page numbers. Tests stripping page furniture (noise).',
    pages: 2,
    build(doc) {
      const header = (t: string) => doc.font(BODY).fontSize(8).fillColor('#888').text('ACME Confidential', 56, 28, { lineBreak: false });
      const footer = (n: number) => doc.font(BODY).fontSize(8).fillColor('#888').text(`Page ${n}`, 56, 800, { lineBreak: false });
      // page 1
      header('');
      footer(1);
      doc.fillColor('#000');
      doc.y = 56;
      h(doc, 1, 'Annual Report');
      para(doc, 'The company grew across every region this year with particular strength in Europe.');
      para(doc, 'Operating costs held flat while headcount rose, improving margins meaningfully.');
      // page 2
      doc.addPage();
      header('');
      footer(2);
      doc.fillColor('#000');
      doc.y = 56;
      h(doc, 2, 'Outlook');
      para(doc, 'Next year the focus shifts to retention and to shipping the long-promised mobile app.');
    },
    groundTruth: [
      '# Annual Report',
      '',
      'The company grew across every region this year with particular strength in Europe.',
      '',
      'Operating costs held flat while headcount rose, improving margins meaningfully.',
      '',
      '## Outlook',
      '',
      'Next year the focus shifts to retention and to shipping the long-promised mobile app.',
      '',
    ].join('\n'),
  },

  {
    id: 'table-numeric',
    description: 'Right-aligned numeric columns with $ signs — financial-statement style.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Financials');
      const cols = [
        { x: 56, w: 130, a: 'left' as const },
        { x: 200, w: 80, a: 'right' as const },
        { x: 300, w: 80, a: 'right' as const },
      ];
      const rows = [
        ['Item', '2023', '2022'],
        ['Revenue', '$1,200', '$980'],
        ['Costs', '$450', '$510'],
        ['Profit', '$750', '$470'],
      ];
      let y = doc.y + 6;
      doc.fontSize(SIZE.body);
      rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          doc.font(r === 0 ? BOLD : BODY).text(cell, cols[c].x, y, { width: cols[c].w, align: cols[c].a, lineBreak: false });
        });
        y += 22;
      });
    },
    groundTruth: [
      '# Financials',
      '',
      '| Item | 2023 | 2022 |',
      '| --- | --- | --- |',
      '| Revenue | $1,200 | $980 |',
      '| Costs | $450 | $510 |',
      '| Profit | $750 | $470 |',
      '',
    ].join('\n'),
  },

  {
    id: 'table-wrapped',
    description: 'A table with a multi-line (wrapped) cell — tests logical-row merging.',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Features');
      const fX = 56;
      const dX = 150;
      const sX = 320;
      const dW = 130;
      const rows: Array<[string, string, string, boolean]> = [
        ['Feature', 'Description', 'Status', true],
        ['Export', 'Download all of your data as a single CSV file', 'Done', false],
        ['Sync', 'Keep devices synced', 'WIP', false],
      ];
      let y = doc.y + 6;
      doc.fontSize(SIZE.body);
      for (const [f, d, s, hd] of rows) {
        const font = hd ? BOLD : BODY;
        doc.font(font).text(f, fX, y, { width: 80, lineBreak: false });
        doc.font(font).text(s, sX, y, { width: 60, lineBreak: false });
        doc.font(font).text(d, dX, y, { width: dW }); // may wrap to multiple lines
        const dh = doc.heightOfString(d, { width: dW });
        y += Math.max(20, dh) + 10;
      }
    },
    groundTruth: [
      '# Features',
      '',
      '| Feature | Description | Status |',
      '| --- | --- | --- |',
      '| Export | Download all of your data as a single CSV file | Done |',
      '| Sync | Keep devices synced | WIP |',
      '',
    ].join('\n'),
  },
  {
    id: 'tiny-spaces',
    description:
      'Word/Google-Docs export pattern: space glyphs drawn at font size ~1 between normal-size words. A converter that drops degenerate glyphs before honouring whitespace fuses whole lines ("Backendengineerwith8+years…").',
    pages: 1,
    build(doc) {
      h(doc, 1, 'Career Summary');
      // pdfkit's .text() silently drops whitespace-only runs, so the export
      // pattern is emitted as raw operators: each word as a size-11 Tj, each
      // inter-word space as a REAL space glyph at size 1 (what Word/Google
      // Docs exporters produce). The font registered by h() above serves the
      // whole page.
      const fid = doc._font.id;
      // Per word: show it, kern an extra ~2.75pt of word gap (-250/1000 of
      // 11pt — under the converter's 0.3×size gap-split threshold, so only
      // the space GLYPH can separate these words), then the size-1 space.
      const line = (text: string, x: number, y: number) =>
        `BT /${fid} 11 Tf ${x} ${y} Td ` +
        text
          .split(' ')
          .map((w, i, a) => `[(${w}) -250] TJ` + (i < a.length - 1 ? ` /${fid} 1 Tf ( ) Tj /${fid} 11 Tf` : ''))
          .join(' ') +
        ' ET\n';
      const py = doc.page.height - doc.y;
      // pdfkit's page CTM is a y-flip (top-left origin); wrap in a second
      // flip so the raw operators run in standard bottom-up PDF coordinates.
      doc.addContent(
        `q 1 0 0 -1 0 ${doc.page.height} cm\n` +
          line('Backend engineer with 8+ years of experience building', 56, py) +
          line('reliable payment systems and internal tools.', 56, py - 13) +
          line('Led the architecture of a platform that processed more than $3M in successful payments.', 56, py - 41) +
          'Q\n',
      );
    },
    groundTruth: [
      '# Career Summary',
      '',
      'Backend engineer with 8+ years of experience building reliable payment systems and internal tools.',
      '',
      'Led the architecture of a platform that processed more than $3M in successful payments.',
      '',
    ].join('\n'),
  },
];

export async function renderPdf(build: (doc: any) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  build(doc);
  doc.end();
  await ended;
  return Buffer.concat(chunks);
}
