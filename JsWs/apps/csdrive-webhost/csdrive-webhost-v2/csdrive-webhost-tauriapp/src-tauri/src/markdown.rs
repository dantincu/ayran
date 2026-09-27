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
const BOOTSTRAP: &str = "
(function () {
  var t = window.__TAURI__
  if (!t) return
  var SCROLL_KEY = 'csdrive-md-at-bottom'
  function atBottom() {
    return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 4
  }
  function restoreScrollIfWasAtBottom() {
    try {
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
  t.webviewWindow.getCurrentWebviewWindow().listen('tab-navigate', function () { location.reload() })
  t.core.invoke('init_window_tab', { appVersion: 1, url: location.href, resourceType: null }).then(function (tab) {
    apply(tab.codeSnippets)
    var label = { firstRow: [{ text: document.title, bold: true }], secondRow: [{ text: decodeURIComponent(location.pathname.replace(/^\\//, '')) }] }
    var resourceId = decodeURIComponent(location.pathname.replace(/^\\//, '')) + location.search
    return t.core.invoke('update_tab_resource', { tabGuid: tab.tabGuid, tabText: label, resourceType: null, resourceId: resourceId })
  }).catch(function () {})
})()
";

/// The whole html page for markdown `source` (a file called `file_name`).
pub fn render_page(source: &str, file_name: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events: Vec<Event> = Parser::new_ext(source, options).collect();

    // The title is the first heading's text, else the file's name.
    let mut title = String::new();
    let mut in_heading = false;
    for event in &events {
        match event {
            Event::Start(Tag::Heading { .. }) if title.is_empty() => in_heading = true,
            Event::End(TagEnd::Heading(_)) if in_heading => break,
            Event::Text(text) | Event::Code(text) if in_heading => title.push_str(text),
            _ => {}
        }
    }
    let title = if title.trim().is_empty() { file_name.to_string() } else { title.trim().to_string() };

    let mut body = String::new();
    html::push_html(&mut body, events.into_iter());
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
}
