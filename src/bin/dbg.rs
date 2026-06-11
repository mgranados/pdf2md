use pdfium_render::prelude::*;
fn main() {
    let folder = std::env::var("PDFIUM_LIB_DIR").unwrap_or_else(|_| "./pdfium-lib/lib".into());
    let pdfium = Pdfium::new(Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&folder)).unwrap());
    let doc = pdfium.load_pdf_from_file(&std::env::args().nth(1).unwrap(), None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let mut h = 0;
    let mut v = 0;
    let mut other = 0;
    let mut samples = Vec::new();
    for obj in page.objects().iter() {
        if let Some(_path) = obj.as_path_object() {
            if let Ok(b) = obj.bounds() {
                let w = b.right().value - b.left().value;
                let ht = b.top().value - b.bottom().value;
                if ht <= 2.5 && w >= 8.0 {
                    h += 1;
                    if samples.len() < 3 { samples.push(format!("H y={:.1} x={:.1}..{:.1}", b.bottom().value, b.left().value, b.right().value)); }
                } else if w <= 2.5 && ht >= 8.0 {
                    v += 1;
                    if samples.len() < 6 { samples.push(format!("V x={:.1} y={:.1}..{:.1}", b.left().value, b.bottom().value, b.top().value)); }
                } else {
                    other += 1;
                }
            }
        }
    }
    println!("h-rulings: {h} | v-rulings: {v} | other paths: {other}");
    for s in samples { println!("  {s}"); }
}
