//! PDF → HTML: a **heuristic** conversion, not a layout-faithful one. `docs/features/features.md`'s
//! third "New Feature" — see CLAUDE.md's "PDF conversion and viewing" for the full picture (the other
//! half, HTML → Markdown, is `html_to_markdown.rs`; the viewer is a bundled PDF.js page, not this module).
//!
//! Built on **pdfium-render** (bindings to Google's PDFium — what Chrome's own PDF viewer is built on),
//! chosen over a pure-Rust text extractor specifically for fidelity: PDFium already merges individual
//! glyphs into per-baseline **text segments** (`PdfPageText::segments`, "Pdfium automatically merges
//! smaller text boxes into larger text segments if all enclosed characters share the same baseline and
//! the same font settings" — its own doc comment), so this module's own job starts one level up: turning
//! a page's segments and image objects into **lines** (segments at the same height), **paragraphs**
//! (consecutive lines close enough together), and a **heading guess** (a line whose font size stands out
//! from the page's own most-common size) — a real, bounded heuristic, not a general layout engine. A
//! two-column page, a table, or a rotated block of text will read out of order or run together; this is a
//! documented, accepted limitation (the same one every simple PDF-to-text/HTML tool has), not a bug to
//! chase — CLAUDE.md's own section says so plainly rather than overclaiming layout fidelity nobody built.
//!
//! **Bold/italic detection has two signals, not one**: a character's own `font_weight()`/`font_is_italic()`
//! come from its font's `/FontDescriptor` — present for an *embedded* font, but a PDF using a bare
//! standard-14 font by name alone (`/BaseFont /Helvetica-Bold`, no descriptor) has none, and pdfium then
//! reports a generic weight for every character — verified live with a hand-built PDF using exactly that
//! (a real hazard, not a hypothetical: `/BaseFont` **names**, like `Helvetica-Bold`/`Times-Italic`, are
//! common in PDFs a lightweight tool or an old workflow produced, not just this module's own test fixture).
//! So `is_bold`/`is_italic` below also check the font's own **name** for "bold"/"italic"/"oblique" — the
//! same practical fallback real PDF-to-HTML tools use — and treat either signal as sufficient.
//!
//! **Images are embedded as `data:` URIs**, not written as separate files: a converted page is meant to be
//! one self-contained document (or one per page, in per-page mode — below), and this keeps it that way
//! without a second output folder of images to keep track of, at the cost of a larger HTML file for an
//! image-heavy page. An image's vertical position on the page places it in the reading order alongside the
//! text paragraphs around it (merged by each item's own top edge), the same "top to bottom" order the text
//! itself is read in.
//!
//! **Where the native PDFium library comes from.** `pdfium-render` doesn't embed PDFium — the C++ library
//! itself is loaded *dynamically at runtime* (`Pdfium::bind_to_library`), from a prebuilt binary this app
//! ships as a bundled resource (`tauri.conf.json`'s `bundle.resources`, `resources/pdfium-win-x64/` today —
//! Windows x64 only, built and verified on; see CLAUDE.md for what every other platform still needs: the
//! matching prebuilt binary from `bblanchon/pdfium-binaries` — MIT/BSD-style licensed, unlike MuPDF's
//! AGPL/commercial dual license, which is exactly why that alternative wasn't used — placed at the same
//! `resources/pdfium-<platform>/` shape, and, for Android, bundled as a `.so` under `jniLibs` instead of a
//! Tauri resource, the same distinction the app already makes for other native platform code).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use pdfium_render::prelude::*;
use tauri::{AppHandle, Manager};

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Where the platform's PDFium library is looked for, relative to the resource directory (a bundled
/// build) or `CARGO_MANIFEST_DIR` (a `cargo run` dev build — the resource directory Tauri reports in dev
/// mode isn't reliably this crate's own `resources/` folder, so a compile-time path sidesteps that rather
/// than depending on it). Desktop only — Android's own equivalent is `init_pdfium`'s Android branch below,
/// which needs no path at all.
#[cfg(target_os = "windows")]
const PDFIUM_RESOURCE_DIR: &str = "pdfium-win-x64";
#[cfg(target_os = "macos")]
const PDFIUM_RESOURCE_DIR: &str = "pdfium-mac-x64";
#[cfg(target_os = "linux")]
const PDFIUM_RESOURCE_DIR: &str = "pdfium-linux-x64";

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn candidate_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join(PDFIUM_RESOURCE_DIR));
    }
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(PDFIUM_RESOURCE_DIR));
    dirs
}

/// Binds to the platform's PDFium library the first time it's needed and keeps the binding for the rest
/// of the process — loading a native library isn't something to repeat per conversion. `Pdfium` itself is
/// `Send + Sync` (the crate's own unsafe impls, since every call serializes through PDFium's own internal
/// lock), so one instance behind a `OnceLock` is enough; no `Mutex` needed on top.
static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn init_pdfium(app: &AppHandle) -> Result<Pdfium, String> {
    let mut last_err = "no candidate directory for the PDFium library was found".to_string();
    for dir in candidate_dirs(app) {
        match Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir)) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(e) => last_err = format!("{dir:?}: {e}"),
        }
    }
    Err(format!(
        "Couldn't load the PDFium library ({last_err}). See CLAUDE.md's \"PDF conversion and viewing\" for where it needs to be."
    ))
}

/// Android has no "resource directory" to search at all: the library is bundled as an ordinary native
/// library instead (`gen/android/app/pdfium-libs/<abi>/libpdfium.so`, added as an extra `jniLibs` source
/// directory in `build.gradle.kts` — see that file's own comment for why not the default one), which the
/// OS extracts into the app's own native library directory and — critically — already searches
/// *automatically* for a bare library name, the same way it finds this app's own compiled Rust library.
/// `bind_to_system_library` does exactly that bare-name lookup (`libloading::Library::new("libpdfium.so")`,
/// no path prepended), so no `resources/`-style directory search is needed here at all.
#[cfg(target_os = "android")]
fn init_pdfium(_app: &AppHandle) -> Result<Pdfium, String> {
    Pdfium::bind_to_system_library().map(Pdfium::new).map_err(|e| {
        format!("Couldn't load the PDFium library ({e}). See CLAUDE.md's \"PDF conversion and viewing\" for where it needs to be.")
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
fn init_pdfium(_app: &AppHandle) -> Result<Pdfium, String> {
    Err("PDF conversion isn't available on this platform yet.".to_string())
}

fn pdfium(app: &AppHandle) -> Result<&'static Pdfium, String> {
    match PDFIUM.get_or_init(|| init_pdfium(app)) {
        Ok(p) => Ok(p),
        Err(e) => Err(e.clone()),
    }
}

/// One converted page: `page_number` is 1-based, `html` is just the page's own body content — no `<html>`
/// wrapper, no title, no stylesheet (the caller wraps it, the same division of labour as `markdown.rs`'s
/// `render_fragment` vs `render_page`).
pub struct ConvertedPage {
    pub page_number: usize,
    pub html: String,
}

/// Converts every page of the PDF `bytes` to html. `embed_images` off skips image extraction entirely —
/// faster, and smaller output, for a person who only wants the text.
pub fn convert(app: &AppHandle, bytes: &[u8], embed_images: bool) -> Result<Vec<ConvertedPage>, String> {
    let pdfium = pdfium(app)?;
    let document = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(|e| e.to_string())?;
    let mut pages = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        let html = page_to_html(&document, &page, embed_images)?;
        pages.push(ConvertedPage { page_number: index + 1, html });
    }
    Ok(pages)
}

struct Line {
    top: f32,
    bottom: f32,
    /// Each segment's own (text, is_bold, is_italic, font_size), left to right.
    runs: Vec<(String, bool, bool, f32)>,
}

enum Item {
    /// A paragraph: its own top edge (for interleaving with images) and its lines.
    Paragraph { top: f32, lines: Vec<Line> },
    Image { top: f32, data_uri: String, width: u32, height: u32 },
}

fn is_bold(name: &str, weight: Option<PdfFontWeight>) -> bool {
    let weight_says_bold = match weight {
        Some(PdfFontWeight::Weight700Bold | PdfFontWeight::Weight800 | PdfFontWeight::Weight900) => true,
        Some(PdfFontWeight::Custom(w)) => w >= 700,
        _ => false,
    };
    weight_says_bold || name.to_ascii_lowercase().contains("bold")
}

fn is_italic(name: &str, italic: bool) -> bool {
    italic || {
        let lower = name.to_ascii_lowercase();
        lower.contains("italic") || lower.contains("oblique")
    }
}

fn page_to_html(document: &PdfDocument, page: &PdfPage, embed_images: bool) -> Result<String, String> {
    let text = page.text().map_err(|e| e.to_string())?;

    // 1. Every text segment as (top, bottom, left, text, bold, italic, size) — the input to line grouping.
    struct Seg {
        top: f32,
        bottom: f32,
        left: f32,
        text: String,
        bold: bool,
        italic: bool,
        size: f32,
    }
    let mut segs: Vec<Seg> = Vec::new();
    for seg in text.segments().iter() {
        let s = seg.text();
        if s.trim().is_empty() {
            continue;
        }
        let bounds = seg.bounds();
        let Ok(chars) = seg.chars() else { continue };
        let Some(first) = chars.iter().next() else { continue };
        let name = first.font_name();
        segs.push(Seg {
            top: bounds.top().value,
            bottom: bounds.bottom().value,
            left: bounds.left().value,
            text: s,
            bold: is_bold(&name, first.font_weight()),
            italic: is_italic(&name, first.font_is_italic()),
            size: first.unscaled_font_size().value,
        });
    }
    // Reading order: top to bottom (PDF y grows upward, so descending), then left to right.
    segs.sort_by(|a, b| b.top.partial_cmp(&a.top).unwrap_or(std::cmp::Ordering::Equal).then(a.left.partial_cmp(&b.left).unwrap_or(std::cmp::Ordering::Equal)));

    // 2. Group into lines: a new line starts when the vertical gap from the current line's own top is
    // more than half that line's own height (its font size is the best proxy available for "how tall a
    // line normally is here").
    let mut lines: Vec<Line> = Vec::new();
    for s in segs {
        let starts_new_line = match lines.last() {
            None => true,
            Some(line) => {
                let height = (line.top - line.bottom).max(1.0);
                line.top - s.top > height * 0.6
            }
        };
        if starts_new_line {
            lines.push(Line { top: s.top, bottom: s.bottom, runs: vec![(s.text, s.bold, s.italic, s.size)] });
        } else {
            let line = lines.last_mut().unwrap();
            line.bottom = line.bottom.min(s.bottom);
            line.runs.push((s.text, s.bold, s.italic, s.size));
        }
    }

    // 3. The page's most common font size (rounded to the nearest 0.5pt) — the "body text" baseline that
    // headings are judged relative to.
    let mut size_counts: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();
    for line in &lines {
        for (_, _, _, size) in &line.runs {
            *size_counts.entry((*size * 2.0).round() as i32).or_default() += 1;
        }
    }
    let body_size = size_counts.into_iter().max_by_key(|&(_, count)| count).map(|(s, _)| s as f32 / 2.0).unwrap_or(12.0);

    // 4. Group consecutive lines into paragraphs: a gap much bigger than the line's own height starts a
    // new paragraph.
    let mut items: Vec<Item> = Vec::new();
    let mut current: Vec<Line> = Vec::new();
    let flush = |current: &mut Vec<Line>, items: &mut Vec<Item>| {
        if !current.is_empty() {
            let top = current[0].top;
            items.push(Item::Paragraph { top, lines: std::mem::take(current) });
        }
    };
    for line in lines {
        let starts_new_paragraph = match current.last() {
            None => false,
            Some(prev) => {
                let height = (prev.top - prev.bottom).max(1.0);
                prev.bottom - line.top > height * 0.7
            }
        };
        if starts_new_paragraph {
            flush(&mut current, &mut items);
        }
        current.push(line);
    }
    flush(&mut current, &mut items);

    // 5. Images, each its own item at its own top edge (skipped entirely when `embed_images` is off, so a
    // text-only conversion never pays for decoding one).
    if embed_images {
        for object in page.objects().iter() {
            if let Some(image_object) = object.as_image_object() {
                let Ok(bounds) = object.bounds() else { continue };
                let Ok(image) = image_object.get_processed_image(document) else { continue };
                let width = image.width();
                let height = image.height();
                let mut png = Vec::new();
                if image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_err() {
                    continue;
                }
                let data_uri = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
                items.push(Item::Image { top: bounds.top().value, data_uri, width, height });
            }
        }
    }
    items.sort_by(|a, b| item_top(b).partial_cmp(&item_top(a)).unwrap_or(std::cmp::Ordering::Equal));

    let mut html = String::new();
    for item in &items {
        match item {
            Item::Paragraph { lines, .. } => render_paragraph(lines, body_size, &mut html),
            Item::Image { data_uri, width, height, .. } => {
                html.push_str(&format!("<p><img src=\"{data_uri}\" width=\"{width}\" height=\"{height}\" alt=\"\"/></p>\n"));
            }
        }
    }
    Ok(html)
}

fn item_top(item: &Item) -> f32 {
    match item {
        Item::Paragraph { top, .. } => *top,
        Item::Image { top, .. } => *top,
    }
}

fn render_paragraph(lines: &[Line], body_size: f32, out: &mut String) {
    let max_size = lines.iter().flat_map(|l| l.runs.iter().map(|r| r.3)).fold(0.0f32, f32::max);
    let ratio = if body_size > 0.0 { max_size / body_size } else { 1.0 };
    let (open, close) = if ratio >= 1.8 {
        ("<h1>", "</h1>")
    } else if ratio >= 1.4 {
        ("<h2>", "</h2>")
    } else if ratio >= 1.15 {
        ("<h3>", "</h3>")
    } else {
        ("<p>", "</p>")
    };
    out.push_str(open);
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        for (j, (text, bold, italic, _)) in line.runs.iter().enumerate() {
            if j > 0 {
                out.push(' ');
            }
            let escaped = escape(text);
            match (bold, italic) {
                (true, true) => out.push_str(&format!("<strong><em>{escaped}</em></strong>")),
                (true, false) => out.push_str(&format!("<strong>{escaped}</strong>")),
                (false, true) => out.push_str(&format!("<em>{escaped}</em>")),
                (false, false) => out.push_str(&escaped),
            }
        }
    }
    out.push_str(close);
    out.push('\n');
}

const PAGE_STYLE: &str = "
:root { color-scheme: light dark; }
body { font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; max-width: 60rem; margin: 0 auto; padding: 16px; }
h1, h2, h3 { line-height: 1.25; }
img { max-width: 100%; height: auto; }
";

/// Wraps `body` (one page's or the whole document's converted content) into a full html document.
pub fn wrap_page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{}</title><style>{PAGE_STYLE}</style></head><body>\n{body}\n</body></html>",
        escape(title)
    )
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn file_stem_and_dir(real: &Path) -> Result<(String, PathBuf), String> {
    let stem = real.file_stem().and_then(|s| s.to_str()).ok_or_else(|| "That isn't a valid file name.".to_string())?;
    let dir = real.parent().ok_or_else(|| "That file has no parent folder.".to_string())?;
    Ok((stem.to_string(), dir.to_path_buf()))
}

/// `path`'s own folder, relative to the root (`"docs/report.pdf"` → `"docs"`, `"report.pdf"` → `""`) —
/// computed from the caller's own relative path, never the resolved real one (a window is never told a
/// real path — see `fs_scope.rs`).
fn relative_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

fn join_relative(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfConvertResult {
    /// The written file(s)' paths, relative to `root` — one for a combined conversion, one per page
    /// (inside a new folder named after the PDF) for a per-page one.
    pub files_written: Vec<String>,
}

/// Converts the PDF at `root`/`path` to html: one combined `<stem>.html` beside it, or, with
/// `per_page`, a new `<stem>/` folder holding `page-001.html`, `page-002.html`, … — one entry per page,
/// in reading order. Refuses to overwrite an existing file or folder unless `overwrite` is true.
#[tauri::command]
pub async fn pdf_convert_to_html(
    app: tauri::AppHandle,
    scope: tauri::State<'_, crate::fs_scope::FsScope>,
    root: String,
    path: String,
    per_page: bool,
    embed_images: bool,
    overwrite: Option<bool>,
) -> Result<PdfConvertResult, String> {
    let scope = scope.inner().clone();
    let overwrite = overwrite.unwrap_or(false);
    let rel_dir = relative_dir(&path).to_string();
    crate::fs_commands::blocking(move || {
        let real = scope.check_in(&root, &path, true)?;
        let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
        let (stem, dir) = file_stem_and_dir(&real)?;
        let pages = convert(&app, &bytes, embed_images)?;

        if per_page {
            let out_dir = dir.join(&stem);
            if out_dir.exists() && !overwrite {
                return Err(format!("\"{stem}\" already exists. Choose \"Overwrite\" to replace its contents."));
            }
            std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
            let mut written = Vec::new();
            for page in &pages {
                let file_name = format!("page-{:03}.html", page.page_number);
                let title = format!("{stem} — page {}", page.page_number);
                std::fs::write(out_dir.join(&file_name), wrap_page(&title, &page.html)).map_err(|e| e.to_string())?;
                written.push(join_relative(&join_relative(&rel_dir, &stem), &file_name));
            }
            Ok(PdfConvertResult { files_written: written })
        } else {
            let combined: String = pages.iter().map(|p| p.html.as_str()).collect::<Vec<_>>().join("\n");
            let file_name = format!("{stem}.html");
            let out_file = dir.join(&file_name);
            if out_file.exists() && !overwrite {
                return Err(format!("\"{file_name}\" already exists. Choose \"Overwrite\" to replace it."));
            }
            std::fs::write(&out_file, wrap_page(&stem, &combined)).map_err(|e| e.to_string())?;
            Ok(PdfConvertResult { files_written: vec![join_relative(&rel_dir, &file_name)] })
        }
    })
    .await
}

#[cfg(test)]
pub(crate) mod test_pdf {
    //! A minimal, hand-built one-page PDF (no external file, no external crate) — just enough of the PDF
    //! object model for PDFium to parse: a catalog, a page tree, one page with two Type1 fonts (a plain
    //! and a bold `/BaseFont` name only, deliberately with **no** `/FontDescriptor` — exactly the
    //! `is_bold`'s own doc comment's "a bare standard-14 font has none" case) and a content stream that
    //! draws a large heading, an ordinary paragraph, a bold line, and a second paragraph after a gap.
    pub fn build() -> Vec<u8> {
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>".to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            {
                let content = b"BT\n/F1 24 Tf\n72 700 Td\n(Ayran Test Heading) Tj\nET\n\
                     BT\n/F1 12 Tf\n72 660 Td\n(This is a normal paragraph of body text on the test page.) Tj\nET\n\
                     BT\n/F2 12 Tf\n72 640 Td\n(This line uses a bold font to test bold detection.) Tj\nET\n\
                     BT\n/F1 12 Tf\n72 600 Td\n(Second paragraph, after a gap, to test paragraph grouping.) Tj\nET\n";
                let mut v = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
                v.extend_from_slice(content);
                v.extend_from_slice(b"\nendstream");
                v
            },
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>".to_vec(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(obj);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = out.len();
        let n = objects.len() + 1;
        out.extend_from_slice(format!("xref\n0 {n}\n0000000000 65535 f \n").as_bytes());
        for off in &offsets[1..] {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF").as_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pdfium() -> Pdfium {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(PDFIUM_RESOURCE_DIR);
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir)).expect("bind pdfium for tests");
        Pdfium::new(bindings)
    }

    #[test]
    fn converts_a_heading_two_paragraphs_and_a_bold_line() {
        let pdfium = test_pdfium();
        let bytes = test_pdf::build();
        let document = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load");
        assert_eq!(document.pages().len(), 1);
        let page = document.pages().get(0).unwrap();
        let html = page_to_html(&document, &page, false).unwrap();
        assert!(html.contains("<h1>Ayran Test Heading</h1>"), "{html}");
        assert!(html.contains("<p>This is a normal paragraph of body text on the test page.</p>"), "{html}");
        assert!(html.contains("<strong>This line uses a bold font to test bold detection.</strong>"), "a bare /BaseFont name with no FontDescriptor is still recognised as bold by name: {html}");
        assert!(html.contains("<p>Second paragraph, after a gap, to test paragraph grouping.</p>"), "{html}");
        // Paragraph order follows the page's own top-to-bottom reading order.
        let heading_at = html.find("Ayran Test Heading").unwrap();
        let bold_at = html.find("bold font").unwrap();
        let second_at = html.find("Second paragraph").unwrap();
        assert!(heading_at < bold_at && bold_at < second_at, "{html}");
    }

    #[test]
    fn wrap_page_produces_a_whole_document() {
        let page = wrap_page("A title", "<p>hi</p>");
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<title>A title</title>"));
        assert!(page.contains("<p>hi</p>"));
    }

    #[test]
    fn is_bold_and_is_italic_use_the_font_name_as_a_fallback() {
        assert!(is_bold("Helvetica-Bold", None));
        assert!(is_bold("Arial,Bold", None));
        assert!(!is_bold("Helvetica", None));
        assert!(is_italic("Times-Italic", false));
        assert!(is_italic("Georgia,Oblique", false));
        assert!(!is_italic("Helvetica", false));
    }
}
