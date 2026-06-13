// Char-stream probe: dump unicode, font size, loose-bounds and the gap to the
// previous glyph for the first N chars of page 1 — for diagnosing word-break
// inference on PDFs without space glyphs.
use pdfium_render::prelude::*;

fn main() {
    let folder = std::env::var("PDFIUM_LIB_DIR").unwrap_or_else(|_| "./pdfium-lib/lib".into());
    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&folder)).unwrap(),
    );
    let doc = pdfium.load_pdf_from_file(&std::env::args().nth(1).unwrap(), None).unwrap();
    let n: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(120);
    let page = doc.pages().get(0).unwrap();
    let text = page.text().unwrap();
    let mut prev_right: Option<f32> = None;
    let mut prev_y = f32::NAN;
    let mut spaces = 0usize;
    let mut count = 0usize;
    for ch in text.chars().iter() {
        let c = ch.unicode_char().unwrap_or(' ');
        if c.is_whitespace() {
            spaces += 1;
        }
        let size = ch.scaled_font_size().value;
        let bb = match ch.loose_bounds() {
            Ok(b) => b,
            Err(_) => continue,
        };
        let (l, r, y) = (bb.left().value, bb.right().value, bb.bottom().value);
        let h = bb.top().value - bb.bottom().value;
        let (mb, mc) = ch.matrix().map(|m| (m.b(), m.c())).unwrap_or((0.0, 0.0));
        if count < n {
            let gap = if (y - prev_y).abs() < 1.0 { prev_right.map(|p| l - p) } else { None };
            println!(
                "{:?} size={:.2} l={:.2} r={:.2} y={:.2} h={:.2} mb={:.2} mc={:.2} gap={}",
                c,
                size,
                l,
                r,
                y,
                h,
                mb,
                mc,
                gap.map(|g| format!("{g:.2}")).unwrap_or_else(|| "—".into())
            );
        }
        prev_right = Some(r);
        prev_y = y;
        count += 1;
    }
    println!("total chars: {count}, whitespace chars: {spaces}");
}
