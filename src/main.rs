// pdf2md — the fastest and most accurate PDF→Markdown tool, for agents.
//
// Rust + pdfium port of the validated TS reference heuristics (evals/src/
// pdf2md-proto.ts). pdfium (Google's C++ PDF engine) does the parse + text
// extraction; everything below is native heuristic reconstruction:
//   tokens -> column gutter -> columns -> lines -> reading-order groups ->
//   markdown (headings via font size, lists, GFM tables via logical-row + grid
//   reconstruction, page-furniture/reference stripping).
// Born-digital PDFs only (no OCR) — by design.
use pdfium_render::prelude::*;
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
struct Tok {
    s: String,
    x: f32,
    y: f32,
    w: f32,
    size: f32,
}

#[derive(Clone)]
struct Line {
    toks: Vec<Tok>,
    text: String,
    cells: Vec<String>,
    cell_x: Vec<f32>,
    x: f32,
    y: f32,
    size: f32,
}

// ---- extraction -----------------------------------------------------------

// Locate libpdfium across the likely places, in order: $PDFIUM_LIB_DIR, next
// to the binary (shipped together), <bindir>/pdfium-lib/lib, ./pdfium-lib/lib,
// then the system library. So a release is just `pdf2md` + `libpdfium.*` in one
// folder.
fn bind_pdfium() -> Box<dyn PdfiumLibraryBindings> {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(d) = std::env::var("PDFIUM_LIB_DIR") {
        dirs.push(d);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            dirs.push(p.to_string_lossy().into_owned());
            dirs.push(p.join("pdfium-lib").join("lib").to_string_lossy().into_owned());
        }
    }
    dirs.push("./pdfium-lib/lib".into());
    for d in &dirs {
        if let Ok(b) = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(d)) {
            return b;
        }
    }
    if let Ok(b) = Pdfium::bind_to_system_library() {
        return b;
    }
    eprintln!("pdf2md: could not locate libpdfium. Set PDFIUM_LIB_DIR, or place the");
    eprintln!("        platform library next to the binary. See README / fetch-pdfium.");
    std::process::exit(2);
}

// Stub system-font mapper: all callbacks None -> pdfium uses its built-in
// substitution fonts instead of querying the OS font system (CoreText et al).
// Cuts first-page load ~5x on docs with non-embedded fonts; text + metrics for
// the standard-14 fonts come from pdfium's built-ins. Escape hatch:
// PDF2MD_SYSTEM_FONTS=1 restores the OS mapper.
static mut STUB_FONT_INFO: FPDF_SYSFONTINFO = FPDF_SYSFONTINFO {
    version: 1,
    Release: None,
    EnumFonts: None,
    MapFont: None,
    GetFont: None,
    GetFontData: None,
    GetFaceName: None,
    GetFontCharset: None,
    DeleteFont: None,
};

// One warm pdfium instance: the MCP server (and multi-file CLI) reuse it so
// the per-process init + font-cache cost is paid once, not per document.
fn init_pdfium() -> Pdfium {
    let pdfium = Pdfium::new(bind_pdfium());
    if std::env::var("PDF2MD_SYSTEM_FONTS").is_err() {
        unsafe {
            pdfium.bindings().FPDF_SetSystemFontInfo(&raw mut STUB_FONT_INFO);
        }
    }
    pdfium
}

// ---- lattice tables (ruled grids) -------------------------------------------
//
// Bordered tables pack cells too tightly for whitespace heuristics; their grid
// lives in vector graphics instead. We read thin path objects (and the edges
// of stroked rectangles) as rulings, connect intersecting rulings into grid
// components, and rebuild each component's cells directly from the grid.

struct Lattice {
    top: f32,
    md: String,
}

// point mapping into display space — must match the token mapping in extract()
fn map_pt(rot: PdfPageRenderRotation, px: f32, py: f32) -> (f32, f32) {
    match rot {
        PdfPageRenderRotation::None => (px, py),
        PdfPageRenderRotation::Degrees90 => (py, -px),
        PdfPageRenderRotation::Degrees180 => (-px, -py),
        PdfPageRenderRotation::Degrees270 => (-py, px),
    }
}

fn merge_segments(mut segs: Vec<(f32, f32, f32)>) -> Vec<(f32, f32, f32)> {
    // (pos, a1, a2): collinear within 2.5pt of pos merge when ranges touch (6pt slack)
    segs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.partial_cmp(&b.1).unwrap()));
    let mut out: Vec<(f32, f32, f32)> = Vec::new();
    for s in segs {
        if let Some(last) = out.last_mut() {
            if (s.0 - last.0).abs() <= 2.5 && s.1 <= last.2 + 6.0 {
                last.2 = last.2.max(s.2);
                last.1 = last.1.min(s.1);
                continue;
            }
        }
        out.push(s);
    }
    out
}

fn extract_lattices(page: &PdfPage, rot: PdfPageRenderRotation, toks: Vec<Tok>) -> (Vec<Tok>, Vec<Lattice>) {
    // 1. collect ruling segments in display space
    let mut hs: Vec<(f32, f32, f32)> = Vec::new(); // (y, x1, x2)
    let mut vs: Vec<(f32, f32, f32)> = Vec::new(); // (x, y1, y2)
    let mut add_seg = |p1: (f32, f32), p2: (f32, f32)| {
        let (x1, y1) = p1;
        let (x2, y2) = p2;
        if (y1 - y2).abs() <= 2.5 && (x2 - x1).abs() >= 8.0 {
            hs.push(((y1 + y2) / 2.0, x1.min(x2), x1.max(x2)));
        } else if (x1 - x2).abs() <= 2.5 && (y2 - y1).abs() >= 8.0 {
            vs.push(((x1 + x2) / 2.0, y1.min(y2), y1.max(y2)));
        }
    };
    for obj in page.objects().iter() {
        let Some(path) = obj.as_path_object() else { continue };
        let Ok(b) = obj.bounds() else { continue };
        let (l, r, bo, t) = (b.left().value, b.right().value, b.bottom().value, b.top().value);
        let w = r - l;
        let h = t - bo;
        if h <= 2.5 || w <= 2.5 {
            // thin path = a ruling line
            let mid_y = (bo + t) / 2.0;
            let mid_x = (l + r) / 2.0;
            if h <= 2.5 {
                add_seg(map_pt(rot, l, mid_y), map_pt(rot, r, mid_y));
            } else {
                add_seg(map_pt(rot, mid_x, bo), map_pt(rot, mid_x, t));
            }
        } else if w >= 8.0 && h >= 8.0 && path.is_stroked().unwrap_or(false) {
            // stroked rectangle: its four edges are rulings (cell borders)
            add_seg(map_pt(rot, l, bo), map_pt(rot, r, bo));
            add_seg(map_pt(rot, l, t), map_pt(rot, r, t));
            add_seg(map_pt(rot, l, bo), map_pt(rot, l, t));
            add_seg(map_pt(rot, r, bo), map_pt(rot, r, t));
        }
    }
    let hs = merge_segments(hs);
    let vs = merge_segments(vs);
    if hs.len() < 3 || vs.len() < 3 {
        return (toks, vec![]);
    }

    // 2. connect intersecting rulings into components (union-find)
    let n = hs.len() + vs.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        let mut i = i;
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for (hi, h) in hs.iter().enumerate() {
        for (vi, v) in vs.iter().enumerate() {
            let tol = 4.0;
            if v.0 >= h.1 - tol && v.0 <= h.2 + tol && h.0 >= v.1 - tol && h.0 <= v.2 + tol {
                let a = find(&mut parent, hi);
                let b = find(&mut parent, hs.len() + vi);
                parent[a] = b;
            }
        }
    }
    let mut comps: HashMap<usize, (Vec<usize>, Vec<usize>)> = HashMap::new();
    for hi in 0..hs.len() {
        let root = find(&mut parent, hi);
        comps.entry(root).or_default().0.push(hi);
    }
    for vi in 0..vs.len() {
        let root = find(&mut parent, hs.len() + vi);
        comps.entry(root).or_default().1.push(vi);
    }

    // 3. each component with a real grid becomes a lattice table
    let mut remaining = toks;
    let mut lattices: Vec<Lattice> = Vec::new();
    for (_, (chs, cvs)) in comps {
        if chs.len() < 3 || cvs.len() < 3 {
            continue;
        }
        let mut ys: Vec<f32> = chs.iter().map(|i| hs[*i].0).collect();
        let mut xs: Vec<f32> = cvs.iter().map(|i| vs[*i].0).collect();
        ys.sort_by(|a, b| b.partial_cmp(a).unwrap()); // top first
        ys.dedup_by(|a, b| (*a - *b).abs() <= 2.5);
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        xs.dedup_by(|a, b| (*a - *b).abs() <= 2.5);
        if ys.len() < 3 || xs.len() < 3 {
            continue;
        }
        let (x0, x1) = (xs[0], xs[xs.len() - 1]);
        let (y_top, y_bot) = (ys[0], ys[ys.len() - 1]);
        let n_rows = ys.len() - 1;
        let n_cols = xs.len() - 1;
        // claim tokens whose center lies inside the grid
        let mut grid: Vec<Vec<Vec<Tok>>> = vec![vec![Vec::new(); n_cols]; n_rows];
        let mut kept: Vec<Tok> = Vec::with_capacity(remaining.len());
        let mut claimed = 0usize;
        for t in remaining.drain(..) {
            let cx = t.x + t.w / 2.0;
            let cy = t.y + t.size * 0.35;
            if cx >= x0 && cx <= x1 && cy >= y_bot && cy <= y_top {
                let ri = ys.iter().skip(1).position(|yy| cy >= *yy).unwrap_or(n_rows - 1);
                let ci = xs.iter().skip(1).position(|xx| cx <= *xx).unwrap_or(n_cols - 1);
                grid[ri][ci].push(t);
                claimed += 1;
            } else {
                kept.push(t);
            }
        }
        // Lattice is a FALLBACK: if the claimed tokens already form an
        // aligned multi-cell structure, the whitespace pipeline's calibrated
        // machinery handles them better (finer columns, folds, segmentation)
        // — give them back. Lattice keeps only grids whose content is too
        // tightly packed or ragged for whitespace splitting.
        let claimed_owned: Vec<Tok> = grid.iter().flatten().flatten().cloned().collect();
        let ws_lines: Vec<Line> = group_raw_lines(claimed_owned.clone()).into_iter().map(make_line).collect();
        // ...and only if whitespace's column resolution is at least as fine as
        // the ruling grid's: a coarse whitespace read of a finely ruled grid
        // (frx-style forms) means the rulings carry information whitespace
        // can't see.
        let ws_cols = {
            let tol = 10.0;
            let mut clusters: Vec<(f32, HashSet<usize>)> = Vec::new();
            for (ri, r) in ws_lines.iter().enumerate() {
                for &x in &r.cell_x {
                    if let Some(c) = clusters.iter_mut().find(|c| (c.0 - x).abs() <= tol) {
                        c.1.insert(ri);
                    } else {
                        let mut set = HashSet::new();
                        set.insert(ri);
                        clusters.push((x, set));
                    }
                }
            }
            clusters.iter().filter(|c| c.1.len() as f32 >= ws_lines.len() as f32 * 0.6).count()
        };
        let whitespace_handles = ws_lines.len() >= 2
            && is_aligned_table(&ws_lines)
            && has_table_substance(&ws_lines)
            && (n_cols as f32) < (ws_cols as f32) * 1.5;
        if claimed < 4 || whitespace_handles {
            // decorative box, or whitespace can already handle this region
            for row in grid {
                for cell in row {
                    kept.extend(cell);
                }
            }
            remaining = kept;
            continue;
        }
        // render rows (skip fully empty ones)
        let mut out: Vec<String> = Vec::new();
        let mut emitted = 0usize;
        for row in grid {
            let cells: Vec<String> = row
                .into_iter()
                .map(|mut cell| {
                    cell.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap()));
                    clean(&cell.iter().map(|t| t.s.as_str()).collect::<Vec<_>>().join(" "))
                })
                .collect();
            if cells.iter().all(|c| c.is_empty()) {
                continue;
            }
            out.push(format!("| {} |", cells.join(" | ")));
            emitted += 1;
            if emitted == 1 {
                out.push(format!("| {} |", vec!["---"; n_cols].join(" | ")));
            }
        }
        // Shape + density sanity: real data tables have a modest column count
        // and mostly-filled cells. Blank forms generate absurd pseudo-grids
        // from box edges (a 63x62 grid at 23% fill is a form, not a table) —
        // those read better through the whitespace pipeline.
        let filled: usize = out
            .iter()
            .filter(|r| !r.contains("---"))
            .map(|r| r.trim_matches('|').split('|').filter(|c| !c.trim().is_empty()).count())
            .sum();
        let fill = filled as f32 / (emitted * n_cols) as f32;
        if std::env::var("DBG_LATTICE").is_ok() {
            eprintln!("lattice: rows={n_rows} cols={n_cols} claimed={claimed} emitted={emitted} fill={fill:.2}");
        }
        if emitted >= 2 && n_cols <= 14 && fill >= 0.45 {
            lattices.push(Lattice { top: y_top, md: out.join("\n") });
        } else {
            // not table-shaped: return the tokens (the arbitration clones) to
            // the whitespace path
            kept.extend(claimed_owned);
        }
        remaining = kept;
    }
    lattices.sort_by(|a, b| b.top.partial_cmp(&a.top).unwrap());
    (remaining, lattices)
}

fn extract(pdfium: &Pdfium, path: &str) -> Result<Vec<(Vec<Tok>, Vec<Lattice>)>, String> {
    let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| format!("failed to load pdf: {e:?}"))?;
    let mut pages = Vec::new();
    let n_pages = doc.pages().len();
    // index-based access: PdfPages::iter() measured ~100x slower per page than
    // get(i) (it eagerly loads page resources we never use for text extraction)
    for pi in 0..n_pages {
        let page = match doc.pages().get(pi) {
            Ok(p) => p,
            Err(_) => {
                pages.push((Vec::new(), Vec::new()));
                continue;
            }
        };
        let text = match page.text() {
            Ok(t) => t,
            Err(_) => {
                pages.push((Vec::new(), Vec::new()));
                continue;
            }
        };
        // Rotated pages: pdfium reports glyph geometry in UNROTATED page space
        // and (on rotated text) a scaled font size of 0, which used to make us
        // drop every glyph. Remap coordinates into display orientation so the
        // whole downstream pipeline sees a normal page. (90° verified against
        // real docs; 180/270 are the symmetric mappings.)
        let rot = page.rotation().unwrap_or(PdfPageRenderRotation::None);
        let mut toks: Vec<Tok> = Vec::new();
        let mut cur: Option<Tok> = None;
        let mut cur_right = 0f32;
        let rotated = !matches!(rot, PdfPageRenderRotation::None);
        for ch in text.chars().iter() {
            // Unrotated pages: drop degenerate size<2 glyphs FIRST, silently —
            // exact historical semantics (they never flush a token). Rotated
            // pages report size 0 for everything, so they skip this and use
            // the glyph-height fallback below.
            let raw_size = ch.scaled_font_size().value;
            if raw_size < 2.0 && !rotated {
                continue;
            }
            let c = ch.unicode_char().unwrap_or(' ');
            // whitespace and control chars (pdfium sometimes maps an unmapped
            // glyph to a control codepoint, e.g. U+0002) are word separators,
            // never literal text — never emit them.
            if c.is_whitespace() || c.is_control() {
                if let Some(t) = cur.take() {
                    toks.push(t);
                }
                continue;
            }
            let bb = match ch.loose_bounds() {
                Ok(b) => b,
                Err(_) => {
                    if let Some(t) = cur.take() {
                        toks.push(t);
                    }
                    continue;
                }
            };
            let (bl, br, bbo, bt) = (bb.left().value, bb.right().value, bb.bottom().value, bb.top().value);
            let (left, right, y, h) = match rot {
                PdfPageRenderRotation::None => (bl, br, bbo, bt - bbo),
                PdfPageRenderRotation::Degrees90 => (bbo, bt, -bl, br - bl),
                PdfPageRenderRotation::Degrees180 => (-br, -bl, -bt, bt - bbo),
                PdfPageRenderRotation::Degrees270 => (-bt, -bbo, bl, br - bl),
            };
            // pdfium reports font size 0 for rotated text — on ROTATED pages
            // fall back to the glyph's display-height so the page isn't
            // silently dropped (rotated pages report size 0 for every glyph).
            let size = if raw_size >= 2.0 {
                raw_size
            } else if rotated && h >= 2.0 {
                h
            } else {
                continue;
            };
            // break the current token on a wide gap or a line change
            if let Some(t) = cur.as_ref() {
                if left - cur_right > t.size * 0.3 || (y - t.y).abs() > t.size * 0.6 {
                    toks.push(cur.take().unwrap());
                }
            }
            match cur.as_mut() {
                Some(t) => {
                    t.s.push(c);
                    t.w = right - t.x;
                    if size > t.size {
                        t.size = size;
                    }
                }
                None => {
                    cur = Some(Tok { s: c.to_string(), x: left, y, w: right - left, size });
                }
            }
            cur_right = right;
        }
        if let Some(t) = cur.take() {
            toks.push(t);
        }
        // ruled tables: claim grid-bound tokens, keep the rest for the
        // whitespace pipeline
        pages.push(extract_lattices(&page, rot, toks));
    }
    Ok(pages)
}

// ---- small helpers --------------------------------------------------------

fn qsize(s: f32) -> i32 {
    (s * 2.0).round() as i32
}

fn is_bullet(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if "•·▪◦‣–-".contains(c) => matches!(it.next(), Some(n) if n.is_whitespace()),
        _ => false,
    }
}

fn strip_bullet(s: &str) -> &str {
    s.trim_start_matches(|c| "•·▪◦‣–-".contains(c)).trim_start()
}

// returns the leading ordinal number (e.g. "3" from "3. foo") and the byte length to strip
fn ordered_prefix(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || i >= bytes.len() {
        return None;
    }
    if bytes[i] != b'.' && bytes[i] != b')' {
        return None;
    }
    let mut j = i + 1;
    if j >= bytes.len() || !bytes[j].is_ascii_whitespace() {
        return None;
    }
    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
    }
    Some((s[..i].to_string(), j))
}

fn is_page_num(s: &str) -> bool {
    let t = s.trim();
    let t = t.strip_prefix("Page ").or_else(|| t.strip_prefix("page ")).unwrap_or(t).trim();
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

// collapse letter-spaced runs ("I R S" -> "IRS"), dot leaders, and whitespace.
fn clean(s: &str) -> String {
    let despaced = collapse_letter_spacing(&s.replace('\t', " "));
    let deleadered = collapse_dot_leaders(&despaced);
    let rejoined = rejoin_decimals(&deleadered);
    rejoined.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn collapse_letter_spacing(s: &str) -> String {
    let parts: Vec<&str> = s.split(' ').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        // a run of single-char alphanumeric parts of length >= 3 is tracked text
        let is_single = |p: &str| p.chars().count() == 1 && p.chars().all(|c| c.is_alphanumeric());
        if is_single(parts[i]) {
            let mut j = i;
            while j < parts.len() && is_single(parts[j]) {
                j += 1;
            }
            if j - i >= 3 {
                out.push(parts[i..j].concat());
                i = j;
                continue;
            }
        }
        out.push(parts[i].to_string());
        i += 1;
    }
    out.join(" ")
}

// re-join split decimals: "1 . 0" / "1. 0" -> "1.0"
fn rejoin_decimals(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_digit() {
            // digit [space] '.' space digit
            let mut j = i + 1;
            if j < c.len() && c[j] == ' ' {
                j += 1;
            }
            if j < c.len() && c[j] == '.' && j + 2 < c.len() && c[j + 1] == ' ' && c[j + 2].is_ascii_digit() {
                out.push(c[i]);
                out.push('.');
                i = j + 2;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn collapse_dot_leaders(s: &str) -> String {
    // replace runs of ">=4 dots, possibly space-separated" with a single space
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '.' || (chars[i] == ' ' && i + 1 < chars.len() && chars[i + 1] == '.') {
            let start = i;
            let mut dots = 0;
            let mut j = i;
            while j < chars.len() && (chars[j] == '.' || chars[j] == ' ') {
                if chars[j] == '.' {
                    dots += 1;
                }
                j += 1;
            }
            if dots >= 4 {
                out.push(' ');
                i = j;
                continue;
            }
            i = start;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn median_gap(lines: &[Line]) -> f32 {
    let mut gaps: Vec<f32> = (1..lines.len()).map(|i| lines[i - 1].y - lines[i].y).filter(|g| *g > 0.0).collect();
    if gaps.is_empty() {
        return 0.0;
    }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    gaps[gaps.len() / 2]
}

// ---- line / token assembly ------------------------------------------------

fn join_toks(toks: &[Tok]) -> (String, Vec<String>, Vec<f32>) {
    let mut text = String::new();
    let mut cells: Vec<String> = Vec::new();
    let mut cell_x: Vec<f32> = Vec::new();
    let mut cell = String::new();
    for (i, tok) in toks.iter().enumerate() {
        if i == 0 {
            cell_x.push(tok.x);
        } else {
            let prev = &toks[i - 1];
            let gap = tok.x - (prev.x + prev.w);
            let r = if prev.size > 0.0 { prev.size } else { tok.size.max(11.0) };
            if gap > r * 1.4 {
                cells.push(cell.trim().to_string());
                cell.clear();
                cell_x.push(tok.x);
                text.push('\t');
            } else {
                // tokens are already whitespace/gap-split words, so any non-cell
                // gap between them is a word space (don't rely on the gap size,
                // which pdfium's padded bounds make unreliable).
                text.push(' ');
                cell.push(' ');
            }
        }
        text.push_str(&tok.s);
        cell.push_str(&tok.s);
    }
    cells.push(cell.trim().to_string());
    // collapse runs of spaces/tabs (keep a tab if present in the run)
    let normalized = collapse_ws_keep_tabs(&text);
    (normalized.trim().to_string(), cells, cell_x)
}

fn collapse_ws_keep_tabs(s: &str) -> String {
    let mut out = String::new();
    let mut run_has_tab = false;
    let mut in_run = false;
    for c in s.chars() {
        if c == ' ' || c == '\t' {
            in_run = true;
            if c == '\t' {
                run_has_tab = true;
            }
        } else {
            if in_run {
                out.push(if run_has_tab { '\t' } else { ' ' });
                in_run = false;
                run_has_tab = false;
            }
            out.push(c);
        }
    }
    if in_run {
        out.push(if run_has_tab { '\t' } else { ' ' });
    }
    out
}

fn make_line(mut toks: Vec<Tok>) -> Line {
    toks.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    let (text, cells, cell_x) = join_toks(&toks);
    let x = toks[0].x;
    let y = toks.iter().map(|t| t.y).fold(f32::MIN, f32::max);
    let size = toks.iter().map(|t| t.size).fold(f32::MIN, f32::max);
    Line { toks, text, cells, cell_x, x, y, size }
}

fn group_raw_lines(mut toks: Vec<Tok>) -> Vec<Vec<Tok>> {
    toks.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap()));
    let mut lines: Vec<Vec<Tok>> = Vec::new();
    let mut cur: Vec<Tok> = Vec::new();
    let mut cur_y = f32::NAN;
    for tok in toks {
        let tol = (tok.size * 0.5).max(3.0);
        if !cur.is_empty() && (tok.y - cur_y).abs() > tol {
            lines.push(std::mem::take(&mut cur));
        }
        if cur.is_empty() {
            cur_y = tok.y;
        }
        cur.push(tok);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

// ---- columns (two-column page layout) -------------------------------------

fn detect_gutter(raw: &[Vec<Tok>], min_x: f32, max_x: f32) -> Option<f32> {
    let w = max_x - min_x;
    if w <= 0.0 {
        return None;
    }
    let min_gutter = (w * 0.03).max(14.0);
    let lo = min_x + w * 0.3;
    let hi = min_x + w * 0.7;
    let mut mids: Vec<f32> = Vec::new();
    let mut multi = 0;
    let mut tableish = 0usize;
    for line in raw {
        if line.len() < 2 {
            continue;
        }
        multi += 1;
        let mut xs: Vec<&Tok> = line.iter().collect();
        xs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        let mut best = 0f32;
        let mut best_right = f32::NAN;
        let mut wide_gaps = 0usize;
        for i in 1..xs.len() {
            let gap = xs[i].x - (xs[i - 1].x + xs[i - 1].w);
            if gap > xs[i - 1].size.max(11.0) * 1.4 {
                wide_gaps += 1;
            }
            let mid = (xs[i].x + xs[i - 1].x + xs[i - 1].w) / 2.0;
            if gap > best && mid > lo && mid < hi {
                best = gap;
                best_right = mid;
            }
        }
        // pdfium's loose bounds pad glyph widths, so measured gaps run a few
        // points small vs true advances — compensate on the floor only.
        if best >= min_gutter - 6.0 && best_right.is_finite() {
            mids.push(best_right);
            // a line with ADDITIONAL wide gaps beyond the candidate gutter is
            // a table row, not two-column prose
            if wide_gaps >= 2 {
                tableish += 1;
            }
        }
    }
    if mids.len() < 6 || (mids.len() as f32) < multi as f32 * 0.4 {
        return None;
    }
    // If the gutter-sharing lines are mostly table rows (e.g. a datasheet's
    // label-value gap), this is a wide-gapped TABLE, not a 2-column page —
    // columnizing would tear it in half.
    if tableish as f32 / mids.len() as f32 >= 0.75 {
        return None;
    }
    let mut sorted = mids.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let near: Vec<f32> = mids.iter().copied().filter(|m| (m - median).abs() <= w * 0.06).collect();
    if near.len() < 6 || (near.len() as f32) < multi as f32 * 0.4 {
        return None;
    }
    Some(near.iter().sum::<f32>() / near.len() as f32)
}

fn columnize(raw: Vec<Vec<Tok>>, g: f32, min_gutter: f32) -> Vec<Vec<Line>> {
    let mut groups: Vec<Vec<Line>> = Vec::new();
    let mut left_buf: Vec<Line> = Vec::new();
    let mut right_buf: Vec<Line> = Vec::new();
    let mut full_buf: Vec<Line> = Vec::new();
    macro_rules! flush_cols {
        () => {{
            if !left_buf.is_empty() {
                groups.push(std::mem::take(&mut left_buf));
            }
            if !right_buf.is_empty() {
                groups.push(std::mem::take(&mut right_buf));
            }
        }};
    }
    // Tokens may protrude slightly into the gutter (justified prose whose
    // right edge grazes it); a small slack band keeps such lines splitting
    // cleanly instead of falling to full-width and fragmenting paragraphs.
    const SLACK: f32 = 8.0;
    for toks in raw {
        let left: Vec<Tok> = toks.iter().filter(|t| t.x < g && t.x + t.w <= g + SLACK).cloned().collect();
        let right: Vec<Tok> = toks.iter().filter(|t| t.x >= g - SLACK && t.x + t.w > g).cloned().collect();
        let cross = toks.iter().any(|t| t.x < g - SLACK && t.x + t.w > g + SLACK);
        let gutter_gap = if !left.is_empty() && !right.is_empty() && !cross {
            right.iter().map(|t| t.x).fold(f32::MAX, f32::min)
                - left.iter().map(|t| t.x + t.w).fold(f32::MIN, f32::max)
        } else {
            0.0
        };
        if !left.is_empty() && !right.is_empty() && !cross && gutter_gap >= min_gutter - SLACK * 2.0 {
            if !full_buf.is_empty() {
                groups.push(std::mem::take(&mut full_buf));
            }
            left_buf.push(make_line(left));
            right_buf.push(make_line(right));
        } else if cross || (!left.is_empty() && !right.is_empty()) {
            flush_cols!();
            full_buf.push(make_line(toks));
        } else {
            if !full_buf.is_empty() {
                groups.push(std::mem::take(&mut full_buf));
            }
            if !left.is_empty() {
                left_buf.push(make_line(toks));
            } else {
                right_buf.push(make_line(toks));
            }
        }
    }
    if !full_buf.is_empty() {
        groups.push(full_buf);
    }
    flush_cols!();
    groups
}

// ---- noise / headings -----------------------------------------------------

struct Furniture {
    exact: HashSet<String>,
    norm: HashSet<String>,
}

// Page furniture varies only in its numbers ("[Page 5]", "Lecture 1 - 23",
// dates) — normalize digit runs before comparing across pages.
fn norm_furniture(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_digits = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !in_digits {
                out.push('#');
                in_digits = true;
            }
        } else {
            out.push(c);
            in_digits = false;
        }
    }
    out
}

// Running headers/footers live in the top/bottom TWO lines of a page (court
// opinions and datasheets use two-line headers/footers). Exact repeats on >=2
// pages are furniture; digit-normalized repeats need >=3 pages AND real words
// (>=4 letters) — the letters guard keeps numeric table rows that happen to
// sit at page boundaries (tax brackets, financials) from ever matching.
fn find_furniture(pages_raw: &[Vec<Vec<Tok>>]) -> Furniture {
    let mut exact_count: HashMap<String, usize> = HashMap::new();
    let mut norm_count: HashMap<String, usize> = HashMap::new();
    for raw in pages_raw {
        if raw.is_empty() {
            continue;
        }
        let mut idxs: Vec<usize> = vec![0, 1, raw.len().saturating_sub(2), raw.len() - 1];
        idxs.retain(|i| *i < raw.len());
        idxs.dedup();
        let idxs: HashSet<usize> = idxs.into_iter().collect();
        for idx in idxs {
            let t = make_line(raw[idx].clone()).text;
            if t.is_empty() {
                continue;
            }
            let n = norm_furniture(&t);
            let letters = n.chars().filter(|c| c.is_alphabetic()).count();
            if letters >= 4 {
                *norm_count.entry(n).or_insert(0) += 1;
            }
            *exact_count.entry(t).or_insert(0) += 1;
        }
    }
    Furniture {
        exact: exact_count.into_iter().filter(|(_, c)| *c >= 2).map(|(t, _)| t).collect(),
        norm: norm_count.into_iter().filter(|(_, c)| *c >= 3).map(|(t, _)| t).collect(),
    }
}

fn is_noise(line: &Line, furniture: &Furniture) -> bool {
    is_page_num(&line.text)
        || furniture.exact.contains(&line.text)
        || furniture.norm.contains(&norm_furniture(&line.text))
}

fn body_size_of(lines: &[&Line]) -> f32 {
    let mut freq: HashMap<i32, (usize, f32)> = HashMap::new();
    for l in lines {
        let e = freq.entry(qsize(l.size)).or_insert((0, l.size));
        e.0 += 1;
    }
    freq.values().max_by_key(|(n, _)| *n).map(|(_, s)| *s).unwrap_or(11.0)
}

// Heading sizes compared in quantized 0.5pt steps: a heading must be at least
// ~1pt larger than body. Quantizing first makes the rule immune to sub-point
// noise in reported font sizes (e.g. CVPR's 10.9589 vs 9.9626 body — a raw
// `size >= body + 1.0` misses that by 0.004pt).
fn heading_levels(lines: &[&Line], body: f32) -> Vec<(i32, usize)> {
    let qbody = qsize(body);
    let mut sizes: Vec<f32> = Vec::new();
    let mut seen: HashSet<i32> = HashSet::new();
    for l in lines {
        if qsize(l.size) >= qbody + 2 && seen.insert(qsize(l.size)) {
            sizes.push(l.size);
        }
    }
    sizes.sort_by(|a, b| b.partial_cmp(a).unwrap());
    sizes.iter().enumerate().map(|(i, s)| (qsize(*s), (i + 1).min(3))).collect()
}

// A plausible heading is text, not an equation fragment or figure debris:
// mostly alphanumeric, no display-math glyphs.
fn is_heading_text(s: &str) -> bool {
    if s.chars().any(|c| "∑∫≤≥≈∞±×÷√{}^_".contains(c)) {
        return false;
    }
    let total = s.chars().filter(|c| !c.is_whitespace()).count();
    if total == 0 {
        return false;
    }
    let wordy = s.chars().filter(|c| c.is_alphanumeric() || ".,:;()'&-".contains(*c)).count();
    let spaces = s.chars().filter(|c| c.is_whitespace()).count();
    (wordy + spaces) as f32 / s.chars().count() as f32 >= 0.85
}

// A line is heading-sized only if the heading-size glyphs dominate it — guards
// against stray small-font tokens (figure text) grouped into the same line.
fn heading_dominates(line: &Line) -> bool {
    let q = qsize(line.size);
    let big = line.toks.iter().filter(|t| qsize(t.size) == q).count();
    big * 10 >= line.toks.len() * 7
}

fn level_of(levels: &[(i32, usize)], size: f32) -> Option<usize> {
    levels.iter().find(|(q, _)| *q == qsize(size)).map(|(_, l)| *l)
}

// ---- tables ---------------------------------------------------------------

// Column starts with the width (pt) of the whitespace gutter preceding each.
fn detect_columns_info(rows: &[Line]) -> Vec<(f32, f32)> {
    let toks: Vec<&Tok> = rows.iter().flat_map(|r| r.toks.iter()).collect();
    if toks.is_empty() {
        return vec![];
    }
    let min_x = toks.iter().map(|t| t.x).fold(f32::MAX, f32::min);
    let max_x = toks.iter().map(|t| t.x + t.w).fold(f32::MIN, f32::max);
    let w = max_x - min_x;
    if w <= 0.0 {
        return vec![(min_x, 0.0)];
    }
    let bin = (w / 240.0).max(1.5);
    let nb = (w / bin).ceil() as usize + 1;
    let mut cov = vec![0usize; nb];
    for r in rows {
        let mut seen: HashSet<usize> = HashSet::new();
        for t in &r.toks {
            let a = (((t.x - min_x) / bin).floor() as isize).max(0) as usize;
            let b = (((t.x + t.w - min_x) / bin).floor() as usize).min(nb - 1);
            for i in a..=b {
                seen.insert(i);
            }
        }
        for i in seen {
            cov[i] += 1;
        }
    }
    // <=30%: spanning cells / centered headers may cover a real gutter in a
    // minority of rows.
    let gutter_max = (rows.len() as f32 * 0.3).floor() as usize;
    let min_gutter_bins = ((3.0 / bin).round() as usize).max(2);
    let mut cols: Vec<(f32, f32)> = Vec::new();
    let mut in_content = false;
    let mut gutter_run = 0usize;
    for i in 0..nb {
        if cov[i] <= gutter_max {
            gutter_run += 1;
            if gutter_run >= min_gutter_bins {
                in_content = false;
            }
        } else {
            if !in_content && (cols.is_empty() || gutter_run >= min_gutter_bins) {
                let g = if cols.is_empty() { 0.0 } else { gutter_run as f32 * bin };
                cols.push((min_x + i as f32 * bin, g));
            }
            in_content = true;
            gutter_run = 0;
        }
    }
    cols
}

fn detect_columns(rows: &[Line]) -> Vec<f32> {
    detect_columns_info(rows).into_iter().map(|(x, _)| x).collect()
}

// Side-by-side blocks: a gutter much wider than the segment's typical column
// gutter, with independent table structure (>=2 cells) on BOTH sides in most
// rows, splits the region into stacked tables (human reading order).
fn block_boundaries(rows: &[Line]) -> Vec<f32> {
    let info = detect_columns_info(rows);
    let mut gutters: Vec<f32> = info.iter().skip(1).map(|(_, g)| *g).filter(|g| *g > 0.0).collect();
    if gutters.len() < 3 {
        return vec![];
    }
    gutters.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = gutters[gutters.len() / 2];
    let thresh = (med * 2.5).max(18.0);
    let mut bounds = Vec::new();
    for (x, g) in info.iter().skip(1) {
        if *g < thresh {
            continue;
        }
        let mut both = 0usize;
        let mut any = 0usize;
        for r in rows {
            let left = r.cell_x.iter().filter(|cx| **cx < *x).count();
            let right = r.cell_x.iter().filter(|cx| **cx >= *x).count();
            if left + right == 0 {
                continue;
            }
            any += 1;
            if left >= 2 && right >= 2 {
                both += 1;
            }
        }
        if any > 0 && both as f32 / any as f32 >= 0.5 {
            bounds.push(*x);
        }
    }
    bounds
}

// Segment a table region into runs of structurally-compatible rows: a row
// whose cell-start positions mostly miss the recent rows' signature starts a
// new segment (keeps a form's differently-shaped sections from sharing one
// grid). Small fragments (headers, banners) merge forward with their data.
fn segment_by_structure(rows: Vec<Line>) -> Vec<Vec<Line>> {
    let tol = 10.0;
    let window = 3;
    let min_seg = 5;
    let mut segs: Vec<Vec<Line>> = Vec::new();
    let mut cur: Vec<Line> = Vec::new();
    let mut recent: Vec<Vec<f32>> = Vec::new();
    for r in rows {
        if !cur.is_empty() && r.cell_x.len() >= 2 && !recent.is_empty() {
            let matched = r
                .cell_x
                .iter()
                .filter(|x| recent.iter().flatten().any(|c| (*c - **x).abs() <= tol))
                .count();
            if (matched as f32 / r.cell_x.len() as f32) < 0.6 {
                segs.push(std::mem::take(&mut cur));
                recent.clear();
            }
        }
        recent.push(r.cell_x.clone());
        if recent.len() > window {
            recent.remove(0);
        }
        cur.push(r);
    }
    if !cur.is_empty() {
        segs.push(cur);
    }
    // merge-forward: fragments belong with the data below them
    let mut merged: Vec<Vec<Line>> = Vec::new();
    let mut pending: Vec<Line> = Vec::new();
    for s in segs {
        if s.len() < min_seg {
            pending.extend(s);
        } else {
            let mut seg = std::mem::take(&mut pending);
            seg.extend(s);
            merged.push(seg);
        }
    }
    if !pending.is_empty() {
        match merged.last_mut() {
            Some(last) => last.extend(pending),
            None => merged.push(pending),
        }
    }
    merged
}

fn is_aligned_table(rows: &[Line]) -> bool {
    let tol = 10.0;
    let mut clusters: Vec<(f32, usize, HashSet<usize>)> = Vec::new(); // (mean, n, rows)
    for (ri, r) in rows.iter().enumerate() {
        for &x in &r.cell_x {
            if let Some(c) = clusters.iter_mut().find(|c| (c.0 - x).abs() <= tol) {
                c.0 = (c.0 * c.1 as f32 + x) / (c.1 as f32 + 1.0);
                c.1 += 1;
                c.2.insert(ri);
            } else {
                let mut s = HashSet::new();
                s.insert(ri);
                clusters.push((x, 1, s));
            }
        }
    }
    clusters.iter().filter(|c| c.2.len() as f32 >= rows.len() as f32 * 0.6).count() >= 2
}

fn has_table_substance(rows: &[Line]) -> bool {
    let cells: Vec<&String> = rows.iter().flat_map(|r| r.cells.iter()).filter(|c| !c.is_empty()).collect();
    if cells.is_empty() {
        return false;
    }
    let substantial = cells.iter().filter(|c| c.chars().count() >= 3).count();
    substantial as f32 / cells.len() as f32 >= 0.3
}

fn build_table(rows: &[Line], depth: usize) -> String {
    // split side-by-side blocks first; each side rebuilds independently
    if depth < 2 {
        let bounds = block_boundaries(rows);
        if !bounds.is_empty() {
            let mut edges = vec![f32::NEG_INFINITY];
            edges.extend(&bounds);
            edges.push(f32::INFINITY);
            let mut blocks: Vec<String> = Vec::new();
            for b in 0..edges.len() - 1 {
                let mut block_rows: Vec<Line> = Vec::new();
                for r in rows {
                    let toks: Vec<Tok> = r.toks.iter().filter(|t| t.x >= edges[b] && t.x < edges[b + 1]).cloned().collect();
                    if !toks.is_empty() {
                        block_rows.push(make_line(toks));
                    }
                }
                if block_rows.len() >= 2 && block_rows.iter().any(|r| r.cells.len() >= 2) {
                    blocks.push(build_table(&block_rows, depth + 1));
                } else if !block_rows.is_empty() {
                    blocks.push(block_rows.iter().map(|r| clean(&r.text)).collect::<Vec<_>>().join("\n\n"));
                }
            }
            if blocks.len() > 1 {
                return blocks.join("\n\n");
            }
        }
    }

    let tol = 12.0;
    let mut cols = detect_columns(rows);
    if cols.len() < 2 {
        // fallback: cluster cell-start x's
        let mut clusters: Vec<(f32, usize, HashSet<usize>)> = Vec::new();
        for (ri, r) in rows.iter().enumerate() {
            for &x in &r.cell_x {
                if let Some(c) = clusters.iter_mut().find(|c| (c.0 - x).abs() <= tol) {
                    c.0 = (c.0 * c.1 as f32 + x) / (c.1 as f32 + 1.0);
                    c.1 += 1;
                    c.2.insert(ri);
                } else {
                    let mut s = HashSet::new();
                    s.insert(ri);
                    clusters.push((x, 1, s));
                }
            }
        }
        cols = clusters
            .iter()
            .filter(|c| c.2.len() as f32 >= (rows.len() as f32 * 0.25).max(2.0))
            .map(|c| c.0)
            .collect();
        if cols.len() < 2 {
            cols = clusters.iter().map(|c| c.0).collect();
        }
    }
    cols.sort_by(|a, b| a.partial_cmp(b).unwrap());
    cols.dedup_by(|a, b| (*a - *b).abs() <= tol);

    let col_of = |x: f32| -> usize {
        let mut ci = 0;
        for (k, c) in cols.iter().enumerate() {
            if x >= c - tol {
                ci = k;
            } else {
                break;
            }
        }
        ci
    };

    // segment text-lines into logical rows; merge wrapped continuations
    let med = {
        let mut gaps: Vec<f32> = (1..rows.len()).map(|i| rows[i - 1].y - rows[i].y).filter(|g| *g > 0.0).collect();
        gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if gaps.is_empty() { 0.0 } else { gaps[gaps.len() / 2] }
    };
    let mut logical: Vec<Vec<&Line>> = Vec::new();
    for (idx, l) in rows.iter().enumerate() {
        let has_col0 = l.toks.iter().any(|t| col_of(t.x) == 0);
        let gap = if idx > 0 { rows[idx - 1].y - l.y } else { f32::INFINITY };
        let continuation = idx > 0 && !has_col0 && med > 0.0 && gap < med * 0.7;
        if logical.is_empty() || !continuation {
            logical.push(vec![l]);
        } else {
            logical.last_mut().unwrap().push(l);
        }
    }

    let n = cols.len();
    let mut matrix: Vec<Vec<String>> = Vec::new();
    for group in logical.iter() {
        let mut cells = vec![String::new(); n];
        // Cluster the row's tokens into baselines (a superscript sits a few
        // points above the line — same baseline, not a separate line), then
        // read each baseline left-to-right. Keeps "1.0 · 10^20" in order.
        let mut toks: Vec<&Tok> = group.iter().flat_map(|l| l.toks.iter()).collect();
        toks.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap());
        let mut baselines: Vec<Vec<&Tok>> = Vec::new();
        for t in toks {
            let tol = (t.size * 0.6).max(3.0);
            match baselines.last_mut() {
                Some(last) if (last[0].y - t.y).abs() <= tol => last.push(t),
                _ => baselines.push(vec![t]),
            }
        }
        for line in baselines.iter_mut() {
            line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
            // Gap-gated column transitions: move to a new column only when
            // there is real whitespace at the boundary. Content glued across
            // a boundary is a SPANNING cell (e.g. "3.3 · 10^18" centered under
            // two columns) and stays whole; long labels drifting under the
            // next column stay intact too.
            let mut ci: Option<usize> = None;
            let mut prev: Option<&Tok> = None;
            for t in line.iter() {
                let t_col = col_of(t.x);
                match (ci, prev) {
                    (None, _) => ci = Some(t_col),
                    (Some(c), Some(p)) if t_col != c => {
                        let gap = t.x - (p.x + p.w);
                        if gap >= p.size.max(t.size) * 0.5 {
                            ci = Some(t_col);
                        }
                    }
                    _ => {}
                }
                let c = ci.unwrap();
                if cells[c].is_empty() {
                    cells[c] = t.s.clone();
                } else {
                    cells[c].push(' ');
                    cells[c].push_str(&t.s);
                }
                prev = Some(t);
            }
        }
        matrix.push(cells.iter().map(|c| clean(c)).collect());
    }

    // Repeated-column-group fold: pages like tax tables print the SAME logical
    // table side by side (3 blocks of 6 columns, identical headers). When a
    // well-populated early row repeats with period p, split into p-column
    // blocks and emit them stacked — that's the human reading order.
    if let Some(p) = detect_repeat_period(&matrix, n) {
        let mut blocks: Vec<String> = Vec::new();
        for b in 0..n / p {
            let sub: Vec<&Vec<String>> = matrix.iter().filter(|r| r[b * p..(b + 1) * p].iter().any(|c| !c.is_empty())).collect();
            if sub.is_empty() {
                continue;
            }
            let fmt = |r: &Vec<String>| format!("| {} |", r[b * p..(b + 1) * p].join(" | "));
            let mut out = vec![fmt(sub[0]), format!("| {} |", vec!["---"; p].join(" | "))];
            for r in sub.iter().skip(1) {
                out.push(fmt(r));
            }
            blocks.push(out.join("\n"));
        }
        return blocks.join("\n\n");
    }

    let mut out: Vec<String> = Vec::new();
    for (gi, cleaned) in matrix.iter().enumerate() {
        out.push(format!("| {} |", cleaned.join(" | ")));
        if gi == 0 {
            out.push(format!("| {} |", vec!["---"; n].join(" | ")));
        }
    }
    out.join("\n")
}

// Find a period p (>=3 columns, >=2 blocks) such that some well-populated row
// among the first few repeats itself across all blocks (normalized equality).
fn detect_repeat_period(matrix: &[Vec<String>], n: usize) -> Option<usize> {
    let norm_cell = |s: &str| -> String {
        let mut out = String::new();
        let mut last_space = true;
        for c in s.to_lowercase().chars() {
            if c.is_alphanumeric() {
                out.push(c);
                last_space = false;
            } else if !last_space {
                out.push(' ');
                last_space = true;
            }
        }
        out.trim().to_string()
    };
    for p in 3..=n / 2 {
        if n % p != 0 {
            continue;
        }
        let blocks = n / p;
        for row in matrix.iter().take(4) {
            let non_empty = row.iter().filter(|c| !c.is_empty()).count();
            if (non_empty as f32) < p as f32 * 1.5 {
                continue;
            }
            let mut pairs = 0usize;
            let mut same = 0usize;
            for i in 0..p {
                for b in 1..blocks {
                    let a = norm_cell(&row[i]);
                    let c = norm_cell(&row[i + b * p]);
                    if !a.is_empty() || !c.is_empty() {
                        pairs += 1;
                        if a == c {
                            same += 1;
                        }
                    }
                }
            }
            if pairs >= p && same as f32 / pairs as f32 >= 0.8 {
                return Some(p);
            }
        }
    }
    None
}

// ---- classification -> markdown blocks ------------------------------------

fn classify(groups: &[Vec<Line>], body: f32, levels: &[(i32, usize)]) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    for lines in groups {
        let med = median_gap(lines);
        let para_break = if lines.len() >= 5 && med > 0.0 { med * 1.5 } else { body * 1.6 };
        let mut para: Vec<String> = Vec::new();
        let mut last_y = f32::NAN;
        let flush_para = |para: &mut Vec<String>, blocks: &mut Vec<String>| {
            if !para.is_empty() {
                let mut s = String::new();
                for ln in para.iter() {
                    if s.is_empty() {
                        s = ln.clone();
                    } else if s.ends_with('-') {
                        // de-hyphenate a soft line-break hyphen ("con-" + "verging"
                        // -> "converging") when it joins a word continuation; keep
                        // it for real compounds (next word capitalised / numeric).
                        let before = s.chars().rev().nth(1);
                        let next_lower = ln.chars().next().map(|c| c.is_lowercase()).unwrap_or(false);
                        if before.map(|c| c.is_alphabetic()).unwrap_or(false) && next_lower {
                            s.pop();
                        }
                        s.push_str(ln);
                    } else {
                        s.push(' ');
                        s.push_str(ln);
                    }
                }
                blocks.push(clean(&s));
                para.clear();
            }
        };
        let mut i = 0;
        while i < lines.len() {
            let line = &lines[i];
            // table region: multi-cell rows + wrapped continuations
            if line.cells.len() >= 2 {
                let start_x = line.x;
                let mut last = line.y + 1.0;
                let mut region: Vec<&Line> = Vec::new();
                while i < lines.len() {
                    let l = &lines[i];
                    let multi = l.cells.len() >= 2;
                    let gap = last - l.y;
                    let cont = !multi && !region.is_empty() && gap >= 0.0 && gap < l.size * 2.2 && l.x > start_x + 8.0;
                    if !multi && !cont {
                        break;
                    }
                    region.push(l);
                    last = l.y;
                    i += 1;
                }
                let owned: Vec<Line> = region
                    .iter()
                    .map(|l| Line {
                        toks: l.toks.clone(),
                        text: l.text.clone(),
                        cells: l.cells.clone(),
                        cell_x: l.cell_x.clone(),
                        x: l.x,
                        y: l.y,
                        size: l.size,
                    })
                    .collect();
                if owned.len() >= 2 {
                    // a region may contain structurally different sections
                    // (forms): segment first, emit each table-worthy segment
                    // as its own table
                    let segments = segment_by_structure(owned);
                    let worthy: Vec<bool> = segments
                        .iter()
                        .map(|s| s.len() >= 2 && is_aligned_table(s) && has_table_substance(s))
                        .collect();
                    if worthy.iter().any(|w| *w) {
                        flush_para(&mut para, &mut blocks);
                        for (seg, w) in segments.iter().zip(worthy.iter()) {
                            if *w {
                                blocks.push(build_table(seg, 0));
                            } else {
                                for r in seg {
                                    blocks.push(clean(&r.text));
                                }
                            }
                        }
                        continue;
                    }
                }
                i -= region.len();
            }
            let lvl = level_of(levels, line.size);
            if let Some(l) = lvl {
                if qsize(line.size) >= qsize(body) + 2
                    && word_count(&line.text) <= 12
                    && is_heading_text(&line.text)
                    && heading_dominates(line)
                {
                    flush_para(&mut para, &mut blocks);
                    blocks.push(format!("{} {}", "#".repeat(l), clean(&line.text)));
                    last_y = line.y;
                    i += 1;
                    continue;
                }
            }
            if is_bullet(&line.text) || ordered_prefix(&line.text).is_some() {
                flush_para(&mut para, &mut blocks);
                let mut items: Vec<&Line> = Vec::new();
                while i < lines.len() && (is_bullet(&lines[i].text) || ordered_prefix(&lines[i].text).is_some()) {
                    items.push(&lines[i]);
                    i += 1;
                }
                let base_x = items.iter().map(|it| it.x).fold(f32::MAX, f32::min);
                let mut list: Vec<String> = Vec::new();
                for it in items {
                    let indent = (((it.x - base_x) / 14.0).round() as i32).max(0) as usize;
                    let pad = "  ".repeat(indent);
                    if let Some((num, off)) = ordered_prefix(&it.text) {
                        list.push(format!("{}{}. {}", pad, num, clean(&it.text[off..])));
                    } else {
                        list.push(format!("{}- {}", pad, clean(strip_bullet(&it.text))));
                    }
                }
                blocks.push(list.join("\n"));
                continue;
            }
            // body line -> paragraph
            if !para.is_empty() && last_y.is_finite() && last_y - line.y > para_break {
                flush_para(&mut para, &mut blocks);
            }
            para.push(line.text.clone());
            last_y = line.y;
            i += 1;
        }
        flush_para(&mut para, &mut blocks);
    }
    blocks
}

// ---- pipeline -------------------------------------------------------------

fn convert(pdfium: &Pdfium, path: &str) -> Result<(String, usize), String> {
    let pages = extract(pdfium, path)?;
    let n_pages = pages.len();
    let mut page_lattices: Vec<Vec<Lattice>> = Vec::with_capacity(n_pages);
    let mut token_pages: Vec<Vec<Tok>> = Vec::with_capacity(n_pages);
    for (toks, lats) in pages {
        token_pages.push(toks);
        page_lattices.push(lats);
    }
    let pages_raw: Vec<Vec<Vec<Tok>>> = token_pages.into_iter().map(group_raw_lines).collect();
    let furniture = find_furniture(&pages_raw);

    let mut page_groups: Vec<Vec<Vec<Line>>> = Vec::new();
    for raw in &pages_raw {
        if raw.is_empty() {
            page_groups.push(vec![]);
            continue;
        }
        let toks: Vec<&Tok> = raw.iter().flatten().collect();
        let min_x = toks.iter().map(|t| t.x).fold(f32::MAX, f32::min);
        let max_x = toks.iter().map(|t| t.x + t.w).fold(f32::MIN, f32::max);
        let g = detect_gutter(raw, min_x, max_x);
        match g {
            None => {
                let lines: Vec<Line> = raw.iter().map(|l| make_line(l.clone())).collect();
                page_groups.push(vec![lines]);
            }
            Some(g) => {
                let min_gutter = ((max_x - min_x) * 0.03).max(14.0);
                page_groups.push(columnize(raw.clone(), g, min_gutter));
            }
        }
    }

    let all_lines: Vec<&Line> = page_groups.iter().flatten().flatten().filter(|l| !is_noise(l, &furniture)).collect();
    let body = body_size_of(&all_lines);
    let levels = heading_levels(&all_lines, body);

    let mut blocks: Vec<String> = Vec::new();
    for (pi, groups) in page_groups.iter().enumerate() {
        let clean_groups: Vec<Vec<Line>> = groups
            .iter()
            .map(|g| {
                g.iter()
                    .filter(|l| !is_noise(l, &furniture))
                    .map(|l| Line {
                        toks: l.toks.clone(),
                        text: l.text.clone(),
                        cells: l.cells.clone(),
                        cell_x: l.cell_x.clone(),
                        x: l.x,
                        y: l.y,
                        size: l.size,
                    })
                    .collect::<Vec<Line>>()
            })
            .filter(|g| !g.is_empty())
            .collect();
        let lats = &page_lattices[pi];
        if lats.is_empty() {
            blocks.extend(classify(&clean_groups, body, &levels));
            continue;
        }
        // Interleave lattice tables with the page's text groups by position:
        // a lattice goes before the first group that starts below its top.
        // Groups keep their reading order (never re-sorted — column flows
        // would interleave wrongly).
        let mut li = 0usize;
        for g in &clean_groups {
            let g_top = g.iter().map(|l| l.y).fold(f32::MIN, f32::max);
            while li < lats.len() && lats[li].top >= g_top {
                blocks.push(lats[li].md.clone());
                li += 1;
            }
            blocks.extend(classify(std::slice::from_ref(g), body, &levels));
        }
        while li < lats.len() {
            blocks.push(lats[li].md.clone());
            li += 1;
        }
    }

    // drop bibliography/references in the back half
    let ref_idx = blocks.iter().enumerate().position(|(i, b)| {
        i as f32 > blocks.len() as f32 * 0.5 && {
            let t = b.trim_start_matches('#').trim().to_lowercase();
            t == "references" || t == "bibliography"
        }
    });
    let kept = match ref_idx {
        Some(idx) => &blocks[..idx],
        None => &blocks[..],
    };

    Ok((format!("{}\n", kept.join("\n\n").trim()), n_pages))
}

// ---- MCP server (stdio) -----------------------------------------------------
//
// `pdf2md --mcp` speaks Model Context Protocol over stdio (newline-delimited
// JSON-RPC 2.0) and exposes one tool: convert_pdf{path}. The pdfium engine is
// initialized ONCE and stays warm, so conversions after the first cost
// low-single-digit milliseconds — no process spawn, no font-cache reload.
fn serve_mcp() {
    use serde_json::{json, Value};
    use std::io::{BufRead, Write};

    let pdfium = init_pdfium();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    let reply = |id: Value, result: Value| {
        let msg = json!({"jsonrpc": "2.0", "id": id, "result": result});
        let mut out = stdout.lock();
        let _ = writeln!(out, "{}", msg);
        let _ = out.flush();
    };
    let reply_err = |id: Value, code: i64, message: &str| {
        let msg = json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}});
        let mut out = stdout.lock();
        let _ = writeln!(out, "{}", msg);
        let _ = out.flush();
    };

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        match method {
            "initialize" => {
                let proto = req
                    .pointer("/params/protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("2024-11-05");
                reply(
                    id,
                    json!({
                        "protocolVersion": proto,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "pdf2md", "version": env!("CARGO_PKG_VERSION")},
                        "instructions": "Convert born-digital PDFs to clean Markdown before reading them. Call convert_pdf with an absolute file path instead of loading a PDF as page images (~10x fewer tokens, milliseconds per call)."
                    }),
                );
            }
            "tools/list" => {
                reply(
                    id,
                    json!({"tools": [{
                        "name": "convert_pdf",
                        "description": "Convert a PDF file to clean structured Markdown (headings, lists, GFM tables, multi-column reading order; page furniture and bibliographies stripped). Use this instead of reading a PDF directly or as page images: ~10x fewer tokens, runs locally in milliseconds. Born-digital PDFs only (no OCR).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "Absolute path to the PDF file"}
                            },
                            "required": ["path"]
                        }
                    }]}),
                );
            }
            "tools/call" => {
                let name = req.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
                if name != "convert_pdf" {
                    reply_err(id, -32602, &format!("unknown tool: {name}"));
                    continue;
                }
                let path = req
                    .pointer("/params/arguments/path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match convert(&pdfium, path) {
                    Ok((md, _)) => reply(id, json!({"content": [{"type": "text", "text": md}], "isError": false})),
                    Err(e) => reply(id, json!({"content": [{"type": "text", "text": format!("pdf2md error: {e}")}], "isError": true})),
                }
            }
            "ping" => reply(id, json!({})),
            "notifications/initialized" | "notifications/cancelled" => { /* no response to notifications */ }
            _ => {
                if !id.is_null() {
                    reply_err(id, -32601, &format!("method not found: {method}"));
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--mcp") {
        serve_mcp();
        return;
    }

    let paths: Vec<&String> = args.iter().skip(1).filter(|a| !a.starts_with("--")).collect();
    if paths.is_empty() {
        eprintln!("usage: pdf2md <file.pdf> [more.pdf ...] [--stats]");
        eprintln!("       pdf2md --mcp     (serve Model Context Protocol over stdio)");
        std::process::exit(1);
    }

    // One warm engine across all files: converting N PDFs in one invocation
    // pays startup once (agents: prefer this over N separate spawns).
    let pdfium = init_pdfium();
    let multi = paths.len() > 1;
    let mut total_pages = 0usize;
    let mut total_chars = 0usize;
    let mut failed = false;
    for path in &paths {
        match convert(&pdfium, path) {
            Ok((md, pages)) => {
                if multi {
                    println!("<!-- pdf2md: {path} -->\n");
                }
                print!("{}", md);
                if multi {
                    println!();
                }
                total_pages += pages;
                total_chars += md.chars().count();
            }
            Err(e) => {
                eprintln!("pdf2md: {path}: {e}");
                failed = true;
            }
        }
    }

    if args.iter().any(|a| a == "--stats") {
        // The point of the tool: feed an agent clean markdown instead of page
        // images. Rough token math (~4 chars/token; ~1600 tokens per page image
        // at high detail) so the saving is legible.
        let out_tokens = total_chars / 4;
        let img_tokens = total_pages * 1600;
        let saved = img_tokens.saturating_sub(out_tokens);
        let pct = if img_tokens > 0 { saved * 100 / img_tokens } else { 0 };
        eprintln!(
            "pdf2md: {total_pages} pages → ~{out_tokens} markdown tokens (vs ~{img_tokens} as page images; ~{saved} saved, {pct}%)"
        );
    }
    if failed {
        std::process::exit(1);
    }
}
