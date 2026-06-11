use pdfium_render::prelude::*;
use std::time::Instant;
fn main() {
    let folder = std::env::var("PDFIUM_LIB_DIR").unwrap_or_else(|_| "./pdfium-lib/lib".into());
    let pdfium = Pdfium::new(Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&folder)).unwrap());
    let path = std::env::args().nth(1).unwrap();
    let doc = pdfium.load_pdf_from_file(&path, None).unwrap();
    let n = doc.pages().len();
    // A: current pattern — 3 FFI calls per char
    let t = Instant::now();
    let mut chars = 0usize;
    for pi in 0..n {
        let page = doc.pages().get(pi).unwrap();
        let text = page.text().unwrap();
        for ch in text.chars().iter() {
            let _ = ch.scaled_font_size();
            let _ = ch.unicode_char();
            let _ = ch.loose_bounds();
            chars += 1;
        }
    }
    let a = t.elapsed();
    // B: batch text via all() + per-char loose_bounds only (1 FFI/char)
    let t = Instant::now();
    let mut units = 0usize;
    for pi in 0..n {
        let page = doc.pages().get(pi).unwrap();
        let text = page.text().unwrap();
        let s = text.all();
        units += s.chars().count();
        for ch in text.chars().iter() {
            let _ = ch.loose_bounds();
        }
    }
    let b = t.elapsed();
    // C: bounds-only + size from bounds height (still 1 FFI/char)
    let t = Instant::now();
    let mut acc = 0f32;
    for pi in 0..n {
        let page = doc.pages().get(pi).unwrap();
        let text = page.text().unwrap();
        for ch in text.chars().iter() {
            if let Ok(bd) = ch.loose_bounds() { acc += bd.top().value - bd.bottom().value; }
        }
    }
    let c = t.elapsed();
    eprintln!("A 3-FFI/char: {a:?} ({chars} chars)");
    eprintln!("B all()+bounds: {b:?} ({units} units)");
    eprintln!("C bounds-only: {c:?} (acc {acc:.0})");
}
