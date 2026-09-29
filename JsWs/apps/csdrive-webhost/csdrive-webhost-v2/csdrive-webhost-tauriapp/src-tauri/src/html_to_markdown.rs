//! HTML → plain markdown: the second half of the PDF conversion feature (`pdf_convert.rs` is the first —
//! see CLAUDE.md's "PDF conversion and viewing" for the whole picture), but not tied to it — this module
//! converts *any* html, not just what `pdf_convert.rs` itself produces, so "convert the html to markdown"
//! also works on a hand-written `.html` file.
//!
//! **"Plain markdown" means no raw html tags survive except `<u></u>`** — the one thing CommonMark has no
//! native syntax for at all (there's no plain-markdown way to underline text), so it's kept literally,
//! exactly as the feature's own spec calls for; every other recognized element becomes real markdown
//! syntax, and an element this module doesn't specifically know how to render (a `<div>`, a `<section>` —
//! including ones the ayran-tag transform itself produces, `ayran_tags.rs`) is **unwrapped**: its own tag
//! never appears in the output, but its children are still walked and converted, so structure a person
//! doesn't care about in markdown just falls away rather than leaking through as an unsupported tag.
//!
//! Built on the same `html5ever`/`markup5ever_rcdom` parse-a-tree-and-walk-it foundation as
//! `ayran_tags.rs` — a real, spec-compliant parser handles whatever html a person's file actually
//! contains, and the walk here is a single recursive descent (unlike `ayran_tags.rs`'s two-pass
//! transform, this only ever needs to go top to bottom once, emitting markdown as it goes).
//!
//! **Escaping.** A run of plain text may itself contain characters markdown gives meaning to (`*`, `_`,
//! `` ` ``, `[`, `]`, a leading `#` or `-`, a backslash) — likely in text pulled out of a PDF, which knows
//! nothing about markdown syntax. `escape_text` backslash-escapes the ones that could otherwise be
//! misread as formatting, so the round trip is faithful: what was plain text in the html reads back as
//! plain text, not accidental emphasis or a heading.

use std::cell::RefCell;

use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};

/// Converts html to plain markdown — a **whole document** (`<!doctype html><html>...`, what
/// `pdf_convert.rs`'s own `wrap_page` produces, and what a real `.html` file on disk almost always is)
/// or a bare fragment (`<p>...`) alike: parsed as a full document (`parse_document`, not
/// `parse_fragment` — html5ever's real tree-construction algorithm synthesizes `<html>`/`<head>`/`<body>`
/// around a fragment-like input just as readily as it finds them in a whole one), then only the `<body>`
/// element's own children are walked — never `<head>`, so a document's `<title>`/`<style>`/`<script>`
/// never leak into the output as plain text. (An earlier version of this function parsed as a *body
/// fragment* instead, which doesn't expect a `<head>` at all — verified live: converting `pdf_convert.rs`'s
/// own generated page put its `<style>` block's raw CSS and its `<title>` text into the markdown as
/// ordinary paragraphs, since the fragment parser has no head-vs-body distinction to keep them out.)
pub fn convert(html: &str) -> String {
    let dom: RcDom = html5ever::driver::parse_document(RcDom::default(), Default::default()).one(html);
    let Some(body) = find_body(&dom.document) else { return String::new() };

    let mut out = String::new();
    for child in body.children.borrow().iter() {
        render_block(child, &mut out);
    }
    // Collapse three-or-more blank lines (block elements each add their own trailing blank line, so a
    // run of several in a row — an empty paragraph, say — would otherwise accumulate) down to exactly one,
    // and trim the very start/end.
    let collapsed = collapse_blank_lines(&out);
    collapsed.trim().to_string() + "\n"
}

fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// A document's real `<body>` element — always found somewhere among the top few levels of a parsed
/// document (`#document > html > body`, the shape html5ever's own tree construction always produces,
/// fragment-like input included), but found by *name*, not by assuming that exact depth, so a
/// document that came with its own explicit (if unusually placed) `<body>` tag is still found correctly.
fn find_body(node: &Handle) -> Option<Handle> {
    if local_name_of(node).as_deref() == Some("body") {
        return Some(node.clone());
    }
    node.children.borrow().iter().find_map(find_body)
}

fn local_name_of(node: &Handle) -> Option<String> {
    match &node.data {
        NodeData::Element { name, .. } => Some(name.local.to_string()),
        _ => None,
    }
}

fn attr(node: &Handle, name: &str) -> Option<String> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs.borrow().iter().find(|a| a.name.local.as_ref() == name).map(|a| a.value.to_string()),
        _ => None,
    }
}

/// Renders a **block-level** node: appends its own markdown, always ending in exactly one blank line
/// (`\n\n`) after it, so consecutive blocks are simply concatenated.
fn render_block(node: &Handle, out: &mut String) {
    match &node.data {
        NodeData::Text { contents } => {
            let text = contents.borrow().to_string();
            if !text.trim().is_empty() {
                out.push_str(&escape_text(text.trim()));
                out.push_str("\n\n");
            }
        }
        NodeData::Element { .. } => {
            let name = local_name_of(node).unwrap_or_default();
            match name.as_str() {
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = name.as_bytes()[1] - b'0';
                    out.push_str(&"#".repeat(level as usize));
                    out.push(' ');
                    render_inline_children(node, out);
                    out.push_str("\n\n");
                }
                "p" | "div" | "section" | "article" | "header" | "footer" | "main" | "figure" if !has_block_children(node) => {
                    let before = out.len();
                    render_inline_children(node, out);
                    if out.len() > before {
                        out.push_str("\n\n");
                    }
                }
                "blockquote" => {
                    let mut inner = String::new();
                    for child in node.children.borrow().iter() {
                        render_block(child, &mut inner);
                    }
                    for line in inner.trim_end().split('\n') {
                        out.push_str("> ");
                        out.push_str(line);
                        out.push('\n');
                    }
                    out.push('\n');
                }
                "ul" | "ol" => {
                    let ordered = name == "ol";
                    for (i, child) in node.children.borrow().iter().filter(|c| local_name_of(c).as_deref() == Some("li")).enumerate() {
                        let marker = if ordered { format!("{}. ", i + 1) } else { "- ".to_string() };
                        out.push_str(&marker);
                        render_inline_children(child, out);
                        out.push('\n');
                    }
                    out.push('\n');
                }
                "pre" => {
                    out.push_str("```\n");
                    out.push_str(&text_content(node));
                    out.push_str("\n```\n\n");
                }
                "hr" => {
                    out.push_str("---\n\n");
                }
                "br" => {
                    out.push('\n');
                }
                "table" | "thead" | "tbody" | "tr" | "td" | "th" => {
                    // Not specifically supported — each row's own text still comes through, space-joined,
                    // rather than being lost entirely.
                    render_inline_children(node, out);
                    if name == "tr" {
                        out.push_str("\n\n");
                    }
                }
                // Any other element (an unwrapped ayran-tag wrapper included) — no markup of its own
                // survives, but its children are still walked as blocks.
                _ => {
                    for child in node.children.borrow().iter() {
                        render_block(child, out);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Whether `node` has any child that `render_block` would treat as its own block (so a `<div>` wrapping
/// paragraphs, say, is walked block-by-block rather than flattened into one inline run).
fn has_block_children(node: &Handle) -> bool {
    const BLOCK_TAGS: &[&str] = &["p", "div", "section", "article", "header", "footer", "main", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "hr", "table"];
    node.children.borrow().iter().any(|c| local_name_of(c).is_some_and(|n| BLOCK_TAGS.contains(&n.as_str())))
}

fn render_inline_children(node: &Handle, out: &mut String) {
    for child in node.children.borrow().iter() {
        render_inline(child, out);
    }
}

/// Renders an **inline** node — text and phrasing elements — appending directly to `out` with no
/// trailing blank line of its own (the enclosing block adds that once, after all its inline content).
fn render_inline(node: &Handle, out: &mut String) {
    match &node.data {
        NodeData::Text { contents } => out.push_str(&escape_text(&contents.borrow())),
        NodeData::Element { .. } => {
            let name = local_name_of(node).unwrap_or_default();
            match name.as_str() {
                "strong" | "b" => {
                    out.push_str("**");
                    render_inline_children(node, out);
                    out.push_str("**");
                }
                "em" | "i" => {
                    out.push('*');
                    render_inline_children(node, out);
                    out.push('*');
                }
                "u" => {
                    // The one html tag "plain markdown" still allows — kept literally, attributes
                    // dropped (there is nothing markdown-meaningful to carry over, and the point is a
                    // plain `<u>...</u>`, not a faithful attribute round trip).
                    out.push_str("<u>");
                    render_inline_children(node, out);
                    out.push_str("</u>");
                }
                "code" => {
                    out.push('`');
                    out.push_str(&text_content(node));
                    out.push('`');
                }
                "a" => {
                    let href = attr(node, "href").unwrap_or_default();
                    out.push('[');
                    render_inline_children(node, out);
                    out.push(']');
                    out.push('(');
                    out.push_str(&href);
                    out.push(')');
                }
                "img" => {
                    let src = attr(node, "src").unwrap_or_default();
                    let alt = attr(node, "alt").unwrap_or_default();
                    out.push_str("![");
                    out.push_str(&alt);
                    out.push_str("](");
                    out.push_str(&src);
                    out.push(')');
                }
                "br" => out.push('\n'),
                // An unknown inline element (a stray span, say) is unwrapped — its own tag never
                // appears, only its text.
                _ => render_inline_children(node, out),
            }
        }
        _ => {}
    }
}

/// The plain text of `node` and everything inside it, concatenated (used for `<pre>`/`<code>`, where
/// nothing inside should be turned into further markdown syntax).
fn text_content(node: &Handle) -> String {
    thread_local! {
        static BUF: RefCell<String> = const { RefCell::new(String::new()) };
    }
    fn walk(node: &Handle, buf: &mut String) {
        match &node.data {
            NodeData::Text { contents } => buf.push_str(&contents.borrow()),
            NodeData::Element { .. } => {
                for child in node.children.borrow().iter() {
                    walk(child, buf);
                }
            }
            _ => {}
        }
    }
    BUF.with(|b| {
        let mut buf = b.borrow_mut();
        buf.clear();
        walk(node, &mut buf);
        buf.clone()
    })
}

/// Backslash-escapes the characters markdown gives meaning to, so plain text (pulled out of a PDF, which
/// knows nothing of markdown syntax) reads back as plain text.
fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, c) in text.chars().enumerate() {
        let needs_escape = matches!(c, '\\' | '*' | '_' | '`' | '[' | ']')
            || (i == 0 && matches!(c, '#' | '-' | '>'))
            || (c == '.' && i > 0 && text[..i].chars().last().is_some_and(|p| p.is_ascii_digit()) && text[..i].trim().chars().all(|p| p.is_ascii_digit()));
        if needs_escape {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownConvertResult {
    /// The written `.md` file(s)' paths, relative to `root` — one for a single file, one per `.html`/
    /// `.htm` file found (directly inside it, not recursively) for a folder.
    pub files_written: Vec<String>,
}

fn is_html_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

fn markdown_name_for(html_name: &str) -> String {
    match html_name.rfind('.') {
        Some(i) => format!("{}.md", &html_name[..i]),
        None => format!("{html_name}.md"),
    }
}

/// Converts the html at `root`/`path` to markdown — a single file (`<stem>.md` beside it), or, when
/// `path` names a folder, every `.html`/`.htm` file directly inside it ("mass convert", the feature's
/// own term — not recursive, matching what `pdf_convert_to_html`'s per-page mode itself produces: one
/// flat folder of pages). Refuses to overwrite an existing `.md` file unless `overwrite` is true.
#[tauri::command]
pub async fn html_convert_to_markdown(
    scope: tauri::State<'_, crate::fs_scope::FsScope>,
    root: String,
    path: String,
    overwrite: Option<bool>,
) -> Result<MarkdownConvertResult, String> {
    let scope = scope.inner().clone();
    let overwrite = overwrite.unwrap_or(false);
    crate::fs_commands::blocking(move || {
        let real = scope.check_in(&root, &path, true)?;
        let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
        let mut written = Vec::new();
        if meta.is_dir() {
            let mut entries: Vec<_> = std::fs::read_dir(&real)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && is_html_name(&e.file_name().to_string_lossy()))
                .collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let html_name = entry.file_name().to_string_lossy().into_owned();
                let md_name = markdown_name_for(&html_name);
                let out_file = real.join(&md_name);
                if out_file.exists() && !overwrite {
                    return Err(format!("\"{md_name}\" already exists. Choose \"Overwrite\" to replace it."));
                }
                let html = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
                std::fs::write(&out_file, convert(&html)).map_err(|e| e.to_string())?;
                written.push(join_relative(&path, &md_name));
            }
            if written.is_empty() {
                return Err("That folder has no .html files directly inside it.".to_string());
            }
        } else {
            let (stem_dir, html_name) = match path.rfind('/') {
                Some(i) => (&path[..i], &path[i + 1..]),
                None => ("", path.as_str()),
            };
            let md_name = markdown_name_for(html_name);
            let out_file = real.parent().ok_or("That file has no parent folder.")?.join(&md_name);
            if out_file.exists() && !overwrite {
                return Err(format!("\"{md_name}\" already exists. Choose \"Overwrite\" to replace it."));
            }
            let html = std::fs::read_to_string(&real).map_err(|e| e.to_string())?;
            std::fs::write(&out_file, convert(&html)).map_err(|e| e.to_string())?;
            written.push(join_relative(stem_dir, &md_name));
        }
        Ok(MarkdownConvertResult { files_written: written })
    })
    .await
}

fn join_relative(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_and_paragraphs() {
        let md = convert("<h1>Title</h1><p>Some text.</p><h2>Sub</h2><p>More.</p>");
        assert_eq!(md, "# Title\n\nSome text.\n\n## Sub\n\nMore.\n");
    }

    #[test]
    fn bold_italic_and_underline() {
        let md = convert("<p>a <strong>bold</strong> and <em>italic</em> and <u>underlined</u> word.</p>");
        assert_eq!(md, "a **bold** and *italic* and <u>underlined</u> word.\n");
    }

    #[test]
    fn links_and_images_become_markdown_syntax_not_raw_tags() {
        let md = convert("<p>see <a href=\"x.html\">this</a> and <img src=\"y.png\" alt=\"pic\"/></p>");
        assert_eq!(md, "see [this](x.html) and ![pic](y.png)\n");
        assert!(!md.contains('<'), "{md}");
    }

    #[test]
    fn lists() {
        let md = convert("<ul><li>one</li><li>two</li></ul>");
        assert_eq!(md, "- one\n- two\n");
        let md = convert("<ol><li>a</li><li>b</li></ol>");
        assert_eq!(md, "1. a\n2. b\n");
    }

    #[test]
    fn an_unrecognized_wrapper_element_is_unwrapped_not_left_as_a_raw_tag() {
        // Exactly what `ayran_tags.rs` produces — a <section> wrapper should disappear, its <p> content
        // rendered normally.
        let md = convert("<section id=\"main\" class=\"card\"><p>inside</p></section>");
        assert_eq!(md, "inside\n");
        assert!(!md.contains('<'), "{md}");
    }

    #[test]
    fn blockquote_and_code() {
        let md = convert("<blockquote><p>quoted text</p></blockquote><p>after</p>");
        assert!(md.starts_with("> quoted text\n\n"), "{md}");
        assert!(md.trim_end().ends_with("after"), "{md}");
        let md = convert("<p>use <code>let x = 1;</code> here</p>");
        assert_eq!(md, "use `let x = 1;` here\n");
    }

    #[test]
    fn plain_text_that_looks_like_markdown_syntax_is_escaped() {
        let md = convert("<p>2 * 3 = 6, and _not_ italic, a [link] that isn't one</p>");
        assert!(md.contains("2 \\* 3 = 6"), "{md}");
        assert!(md.contains("\\_not\\_"), "{md}");
        assert!(md.contains("\\[link\\]"), "{md}");
    }

    #[test]
    fn a_leading_hash_or_dash_in_plain_text_is_escaped_so_it_is_not_read_as_a_heading_or_list() {
        let md = convert("<p># not a heading</p><p>- not a list item</p>");
        assert!(md.contains("\\# not a heading"), "{md}");
        assert!(md.contains("\\- not a list item"), "{md}");
    }

    #[test]
    fn a_whole_document_s_head_never_leaks_into_the_output() {
        // Exactly the shape `pdf_convert.rs`'s own `wrap_page` produces, and what a real `.html` file on
        // disk almost always is — found live: converting this used to put the <title> text and the raw
        // CSS from <style> into the markdown as ordinary paragraphs.
        let html = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>My Title</title><style>body { color: red; }</style></head><body>\n<h1>Heading</h1>\n<p>Body text.</p>\n</body></html>";
        let md = convert(html);
        assert_eq!(md, "# Heading\n\nBody text.\n");
        assert!(!md.contains("My Title"), "{md}");
        assert!(!md.contains("color: red"), "{md}");
    }

    #[test]
    fn no_raw_html_tag_survives_except_u() {
        let md = convert("<div><h1>T</h1><p>x <span>y</span> <strong>z</strong></p></div>");
        // Every '<' in the output must be the start of "<u>" or "</u>" — nothing else.
        let mut rest = md.as_str();
        while let Some(idx) = rest.find('<') {
            assert!(rest[idx..].starts_with("<u>") || rest[idx..].starts_with("</u>"), "{md}");
            rest = &rest[idx + 1..];
        }
    }
}
