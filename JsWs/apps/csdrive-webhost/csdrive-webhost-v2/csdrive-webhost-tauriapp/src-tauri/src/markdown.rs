//! Markdown files as web apps. A `.md` / `.markdown` file that is opened as a web app is not served as
//! it is (as an `.html` file is): the backend turns it into html first, and that html — a whole page —
//! is what the browser gets.
//!
//! - Markdown is html-compatible, so **raw html passes through untouched**: `<style>` and `<script>`
//!   tags in the file work (the page is under the same policy as every web app's, which allows inline
//!   scripts and styles and forbids `eval` and any network access).
//! - Relative links, images, `@import`s and `<script src>`s are ordinary requests for files relative to
//!   the page's own address, and are answered by the same protocol handler that answered for the page.
//! - The page **registers itself as a tab**, as a hand-written web app would: a small script at the end
//!   calls `init_window_tab`, applies the code snippets every web app gets, and labels the tab with the
//!   document's title and path. A tab switched to while the page is showing starts the page over.

use std::ops::Range;
use std::path::Path;

use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};

/// Whether the file is one this module renders.
pub fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const STYLE: &str = "
:root { color-scheme: light dark; }
body { font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; max-width: 60rem; margin: 0 auto; padding: 16px; }
h1, h2, h3, h4 { line-height: 1.25; }
pre { overflow: auto; padding: 12px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); }
code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 0.92em; }
:not(pre) > code { padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); }
table { border-collapse: collapse; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 10px; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 4px solid color-mix(in srgb, currentColor 25%, transparent); opacity: 0.9; }
img { max-width: 100%; }
";

/// Registers the page as a tab (see the module docs). Plain script, no dependencies: it runs where only
/// `window.__TAURI__` exists.
///
/// **Keeps the scroll pinned to the bottom across a reload, if it was there before one** — the note
/// editor's own auto-sync (`notify_file_saved`) reloads this exact page every time the note is saved, and
/// a plain `location.reload()` only restores the *same pixel offset*, not "the bottom": if the edit made
/// the document taller (the usual case — text was appended), that offset is no longer the bottom, so the
/// page looks like it "lost" the scroll on every sync. `sessionStorage` survives a `location.reload()` of
/// the same document (cleared only when the window itself closes) and is exactly this page's own lifetime
/// otherwise (its address never changes — a page can't navigate itself), so it is a page's own place to
/// remember this. Applies to *every* reload of this page (a sync, a tab switch back to it, a manual
/// reload) — there is no meaningful difference in why the content changed, only whether the person was
/// reading the end of it.
///
/// **Three more events, all from the note editor's own window** (`notes_pages.rs`'s `sync_scroll_to_line`/
/// `sync_scroll_nudge`/`sync_refresh_without_scroll`; see CLAUDE.md's "Editor ↔ syncing web app: scroll and
/// refresh options"), sent only to the tab that follows the editor (`tabs.syncs`), same as a save's own reload:
/// - `sync-scroll-to-line` `{ line }` — mirror-scroll (off by default): scrolls to the nearest block whose own
///   `data-line` (below) is at or before `line`, the editor's own topmost visible *source* line.
/// - `sync-scroll-nudge` `"up" | "down" | "pageUp" | "pageDown"` — a step of the editor's own Ctrl+Alt+arrow/
///   PageUp/PageDown, independent of mirror-scroll.
/// - `sync-refresh-no-scroll` — the editor's own "Refresh the web app" button: a deliberate reload that does
///   **not** try to keep or restore the scroll position (unlike the automatic reload on save, above) — a
///   `NO_SCROLL_KEY` flag, checked first and cleared, skips `restoreScrollIfWasAtBottom` for that one load.
///   **On its own this isn't enough**: the webview's own history has its own, separate idea of restoring the
///   previous scroll position across a same-document reload, which runs *outside* this script entirely and
///   fought this flag's own decision (found live: a refresh landed right back where the page was before it, the
///   `NO_SCROLL_KEY` check notwithstanding) — `history.scrollRestoration = 'manual'` (set once, unconditionally,
///   near the top of this script) hands that decision to this script alone on every load, so a fresh load starts
///   at the very top unless `restoreScrollIfWasAtBottom` puts it at the bottom instead.
const BOOTSTRAP: &str = "
(function () {
  var t = window.__TAURI__
  if (!t) return
  var SCROLL_KEY = 'csdrive-md-at-bottom'
  var NO_SCROLL_KEY = 'csdrive-md-no-scroll'
  // The webview's own history has its own idea of restoring the previous scroll position across a reload,
  // entirely outside this script — 'manual' hands that decision to this script alone on every load instead.
  try { history.scrollRestoration = 'manual' } catch (e) {}
  function atBottom() {
    return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 4
  }
  function restoreScrollIfWasAtBottom() {
    try {
      if (sessionStorage.getItem(NO_SCROLL_KEY) === '1') { sessionStorage.removeItem(NO_SCROLL_KEY); return }
      if (sessionStorage.getItem(SCROLL_KEY) === '1') window.scrollTo(0, document.documentElement.scrollHeight)
    } catch (e) {}
  }
  window.addEventListener('beforeunload', function () {
    try { sessionStorage.setItem(SCROLL_KEY, atBottom() ? '1' : '0') } catch (e) {}
  })
  // Right away (the content is already laid out — this script runs at the end of the body), and again once
  // every resource (an image, say) has finished loading and may have changed the page's height.
  restoreScrollIfWasAtBottom()
  window.addEventListener('load', restoreScrollIfWasAtBottom)
  function apply(snippets) {
    ;(snippets || []).forEach(function (s) {
      var el = document.createElement(s.type === 'css' ? 'style' : s.type === 'javascript' ? 'script' : 'div')
      if (s.type === 'css' || s.type === 'javascript') { el.textContent = s.code; document.head.appendChild(el) }
      else { el.innerHTML = s.code; document.body.appendChild(el) }
    })
  }
  var win = t.webviewWindow.getCurrentWebviewWindow()
  win.listen('tab-navigate', function () { location.reload() })
  win.listen('sync-scroll-to-line', function (event) {
    var line = event.payload && event.payload.line
    if (typeof line !== 'number') return
    var nodes = document.querySelectorAll('[data-line]')
    var best = null, bestLine = -1
    for (var i = 0; i < nodes.length; i++) {
      var n = parseInt(nodes[i].getAttribute('data-line'), 10)
      if (n <= line && n > bestLine) { best = nodes[i]; bestLine = n }
    }
    if (best) window.scrollTo(0, best.offsetTop)
  })
  win.listen('sync-scroll-nudge', function (event) {
    var dir = event.payload
    var page = window.innerHeight * 0.9
    if (dir === 'up') window.scrollBy(0, -60)
    else if (dir === 'down') window.scrollBy(0, 60)
    else if (dir === 'pageUp') window.scrollBy(0, -page)
    else if (dir === 'pageDown') window.scrollBy(0, page)
  })
  win.listen('sync-refresh-no-scroll', function () {
    try { sessionStorage.setItem(NO_SCROLL_KEY, '1') } catch (e) {}
    location.reload()
  })
  t.core.invoke('init_window_tab', { appVersion: 1, url: location.href, resourceType: null }).then(function (tab) {
    apply(tab.codeSnippets)
    var label = { firstRow: [{ text: document.title, bold: true }], secondRow: [{ text: decodeURIComponent(location.pathname.replace(/^\\//, '')) }] }
    var resourceId = decodeURIComponent(location.pathname.replace(/^\\//, '')) + location.search
    return t.core.invoke('update_tab_resource', { tabGuid: tab.tabGuid, tabText: label, resourceType: null, resourceId: resourceId })
  }).catch(function () {})
})()
";

/// Just the markdown converted to HTML — no page wrapper, no title, no bootstrap script — for embedding a
/// document's content inside a page of ours (the Help tab's keyboard-shortcuts reference, `help_docs.rs`) rather
/// than serving it as a web app of its own.
pub fn render_fragment(source: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(source, options));
    body
}

/// Wraps each **top-level** block `render_page` renders in `<div data-line="N">…</div>`, `N` its first source
/// line (1-based) — what makes mirror-scroll possible (`sync-scroll-to-line`, above): the editor reports its
/// own topmost visible *source* line, and the web app scrolls to the nearest tagged block at or before it.
/// Reuses `pulldown_cmark`'s own byte-offset tracking (`into_offset_iter`) rather than re-parsing or scanning
/// the rendered HTML; a plain `<div>` around any top-level block (a heading, a paragraph, a list, a table, a
/// quote, a code block, a rule, a raw-html block) changes nothing about how it's laid out — `div` is the least
/// opinionated block element there is, and every CSS selector in `STYLE` above still matches its target as a
/// descendant. A block with no `Start`/`End` pair of its own (a thematic break, `Event::Rule`) is wrapped the
/// same way: opened and closed around that one event, rather than only around `Start`/`End` pairs.
fn body_with_line_anchors<'a>(events: impl Iterator<Item = (Event<'a>, Range<usize>)>, source: &str) -> String {
    let mut annotated: Vec<Event<'a>> = Vec::new();
    let mut depth: i32 = 0;
    for (event, range) in events {
        let is_start = matches!(event, Event::Start(_));
        let is_end = matches!(event, Event::End(_));
        if depth == 0 && !is_end {
            let line = source[..range.start.min(source.len())].matches('\n').count() + 1;
            annotated.push(Event::Html(format!("<div data-line=\"{line}\">").into()));
        }
        if is_start {
            depth += 1;
        }
        annotated.push(event);
        if is_end {
            depth -= 1;
            if depth == 0 {
                annotated.push(Event::Html("</div>\n".into()));
            }
        } else if depth == 0 {
            annotated.push(Event::Html("</div>\n".into()));
        }
    }
    let mut body = String::new();
    html::push_html(&mut body, annotated.into_iter());
    body
}

/// The whole html page for markdown `source` (a file called `file_name`).
pub fn render_page(source: &str, file_name: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events: Vec<(Event, Range<usize>)> = Parser::new_ext(source, options).into_offset_iter().collect();

    // The title is the first heading's text, else the file's name.
    let mut title = String::new();
    let mut in_heading = false;
    for (event, _) in &events {
        match event {
            Event::Start(Tag::Heading { .. }) if title.is_empty() => in_heading = true,
            Event::End(TagEnd::Heading(_)) if in_heading => break,
            Event::Text(text) | Event::Code(text) if in_heading => title.push_str(text),
            _ => {}
        }
    }
    let title = if title.trim().is_empty() { file_name.to_string() } else { title.trim().to_string() };

    let body = body_with_line_anchors(events.into_iter(), source);
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{}</title><style>{STYLE}</style></head><body>\n{body}\n<script>{BOOTSTRAP}</script></body></html>",
        escape(&title)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_files_are_recognised_by_extension() {
        assert!(is_markdown(Path::new("notes/a.md")));
        assert!(is_markdown(Path::new("A.MARKDOWN")));
        assert!(!is_markdown(Path::new("a.html")));
        assert!(!is_markdown(Path::new("md")));
    }

    #[test]
    fn a_page_has_the_first_headings_text_as_its_title_and_the_files_name_otherwise() {
        let page = render_page("intro\n\n# The *big* `plan`\n\ntext\n\n# Second\n", "plan.md");
        assert!(page.contains("<title>The big plan</title>"), "{page}");
        assert!(page.contains("<h1>The <em>big</em> <code>plan</code></h1>"));
        assert!(render_page("no heading here", "plain.md").contains("<title>plain.md</title>"));
        assert!(render_page("# <script>x</script> & \"q\"", "f.md").contains("&amp; &quot;q&quot;"), "a title is escaped");
    }

    #[test]
    fn markdown_becomes_html_and_raw_html_style_and_script_are_left_as_they_are() {
        let page = render_page(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ and a [link](other.md) and ![pic](img/p.png)\n\n- [x] done\n\n<style>p { color: red }</style>\n\n<script>window.hello = 1</script>\n",
            "t.md",
        );
        assert!(page.contains("<table>") && page.contains("<del>gone</del>"));
        assert!(page.contains("<a href=\"other.md\">link</a>") && page.contains("src=\"img/p.png\""), "relative paths stay relative");
        assert!(page.contains("checked"), "task lists");
        assert!(page.contains("<style>p { color: red }</style>") && page.contains("<script>window.hello = 1</script>"), "{page}");
        assert!(page.contains("init_window_tab"), "the page registers itself as a tab");
        assert!(page.starts_with("<!doctype html>"));
    }

    #[test]
    fn the_bootstrap_script_pins_the_scroll_to_the_bottom_across_a_reload() {
        let page = render_page("text", "t.md");
        // Saved before the page unloads (a reload, whatever triggers it — a sync, a tab switch, a
        // manual reload — is the only way this page's content ever changes), restored as soon as
        // there's something to restore it against, and again once every resource has loaded.
        assert!(page.contains("addEventListener('beforeunload'"), "{page}");
        assert!(page.contains("sessionStorage.setItem(SCROLL_KEY"), "{page}");
        assert!(page.contains("restoreScrollIfWasAtBottom()"), "called once outright, not just registered");
        assert!(page.contains("addEventListener('load', restoreScrollIfWasAtBottom)"), "{page}");
    }

    #[test]
    fn every_top_level_block_is_tagged_with_its_own_source_line() {
        let page = render_page("# Heading\n\nA paragraph.\n\n- one\n- two\n\n---\n\n> quoted\n", "t.md");
        // pulldown-cmark's own html writer puts a newline between a block's opening tag and what follows it
        // (including our synthetic wrapper) — these check for that exact, actually-rendered shape.
        assert!(page.contains("<div data-line=\"1\">\n<h1>Heading</h1>\n</div>"), "{page}");
        assert!(page.contains("<div data-line=\"3\">\n<p>A paragraph.</p>\n</div>"), "{page}");
        assert!(page.contains("<div data-line=\"5\">\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</div>"), "a list, as a whole, from its first item's line: {page}");
        // A rule (`---`) has no Start/End pair of its own — still tagged, opened and closed around the one event.
        assert!(page.contains("<div data-line=\"8\">\n<hr />\n</div>"), "{page}");
        assert!(page.contains("<div data-line=\"10\">\n<blockquote>\n<p>quoted</p>\n</blockquote>\n</div>"), "{page}");
        // Nothing *inside* a top-level block gets its own wrapper (only depth-0 blocks do) — one `data-line="…"`
        // attribute per top-level construct (heading, paragraph, list, rule, quote), never one per list item or
        // inline span. (`data-line="` rather than just `data-line`, which the bootstrap script's own JS also
        // mentions — `[data-line]`, `getAttribute('data-line')` — twice, in the selector it reads them back with.)
        assert_eq!(page.matches("data-line=\"").count(), 5, "{page}");
    }

    #[test]
    fn the_bootstrap_script_relays_the_editors_own_scroll_and_refresh_events() {
        let page = render_page("text", "t.md");
        assert!(page.contains("win.listen('sync-scroll-to-line'"), "{page}");
        assert!(page.contains("querySelectorAll('[data-line]')"), "{page}");
        assert!(page.contains("win.listen('sync-scroll-nudge'"), "{page}");
        assert!(page.contains("win.listen('sync-refresh-no-scroll'"), "{page}");
        // The refresh-without-scroll flag is checked (and cleared) *before* the at-bottom one, so it wins.
        // (`getItem(SCROLL_KEY)` isn't itself a substring of `getItem(NO_SCROLL_KEY)` — the character right
        // after the opening parenthesis differs — so the two searches can't accidentally find the same spot.)
        let no_scroll_at = page.find("getItem(NO_SCROLL_KEY)").unwrap();
        let at_bottom_at = page.find("getItem(SCROLL_KEY)").unwrap();
        assert!(no_scroll_at < at_bottom_at, "{page}");
        // The webview's own history has its own idea of restoring the previous scroll position across a reload,
        // outside this script entirely — found live to override `NO_SCROLL_KEY`'s own decision unless disabled.
        assert!(page.contains("history.scrollRestoration = 'manual'"), "{page}");
    }
}
