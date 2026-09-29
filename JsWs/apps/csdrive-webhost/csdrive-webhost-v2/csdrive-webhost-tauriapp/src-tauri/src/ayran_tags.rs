//! The **ayran tag** markup transform — a configurable way to insert real html elements into the
//! markup a markdown file renders to (`markdown.rs`), by writing raw html directly in the markdown
//! source (which already "passes through untouched" — see `markdown.rs`'s own module doc).
//!
//! The person writes a pair of **ayran tags** — one configurable element name (`AyranConfig::tag_name`,
//! default `a-x`) — around whatever markdown/html they want wrapped:
//! ```markdown
//! <a-x a-y="1" a-z="div#wrap.card" data-extra="kept"/>
//! some *markdown* and more `<a-x>` pairs, nested as deep as you like
//! <a-x a-y="1"/>
//! ```
//! Two `tag_name` elements are a **matched pair** when they are **siblings** in the rendered markup and
//! their `id_attr` (`a-y`) values are **equal** — everything between them (their other siblings) becomes
//! the children of a **new** element replacing the pair: its tag name, id and class come from parsing the
//! *first* tag's `selector_attr` (`a-z`) as a tiny `tag#id.class1.class2` selector (any part optional; the
//! tag name defaults to `div`), and every other attribute of the first tag (not `a-y`/`a-z` themselves) is
//! copied onto it as it is. A tag that doesn't match anything, matches **more than one** sibling with the
//! same id, or shares an id with a same-named tag that **isn't** a sibling, is left exactly where it is —
//! same tag, same attributes, same position, still a literal `<a-x>` in the output (though always in its
//! *paired* `<a-x>...</a-x>` form by then, even if it was written self-closing — see "self-closing" below
//! for why that normalization happens regardless of whether a tag ends up matched) — this is deliberately
//! the same rule for all three cases, so a markup mistake shows up as visible `<a-x>` tags rather than a
//! wrong-but-silent transform. Pairs can
//! **nest** (one pair's own between-content contains another complete pair): the innermost ("leaf") pairs
//! — the ones that don't themselves contain another complete pair — are resolved first, so by the time an
//! outer pair is resolved its already-transformed inner content just comes along as ordinary children.
//! An empty `tag_name` **disables the whole feature** (`AyranConfig::is_enabled`) — `apply` becomes a
//! no-op, so nothing is parsed or reserialized when nobody uses it.
//!
//! **Why the default is `a-x`, not `_x`.** A real HTML5 tag name must *start with an ASCII letter* — a
//! tokenizer (this module uses `html5ever`, the same one Firefox/Servo use, deliberately: a spec-compliant
//! parser is far more forgiving of the *rest* of a person's markdown/html than a hand-rolled one would be)
//! never recognizes `<_x ...>` as a tag at all; it is silently left as inert text, so the whole feature
//! would never fire for anyone using an underscore-led name. `a-x`/`a-y`/`a-z` (a letter, then a hyphen —
//! also exactly the shape a real "custom element" name must have) parse as an ordinary, if unknown,
//! element. Configuring a different name later is the person's own choice; a name that doesn't start with
//! a letter simply won't ever match anything, the same as any other tag html5ever can't tokenize.
//!
//! **Why self-closing needs its own pass first.** `<a-x a-y="1"/>` is *not* treated as an empty element by
//! real HTML parsing — the trailing `/` is only honoured for the handful of actual *void* elements
//! (`br`, `img`, `hr`, …); for anything else (verified live against html5ever) it is silently ignored and
//! the tag swallows every following sibling as its own children until an explicit `</a-x>` closes it or an
//! ancestor implicitly does — which would nest the *second* tag of a pair **inside** the first instead of
//! beside it, breaking the whole "matched siblings" model this feature is built on. `rewrite_self_closing`
//! runs first, as a plain text pass over the *specific* configured tag name only (everything else in the
//! markup is untouched and left for the real parser to make sense of): it turns `<a-x a-y="1"/>` into the
//! equivalent explicit empty element `<a-x a-y="1"></a-x>` before html5ever ever sees it, so the person
//! can write self-closing tags exactly as the feature's own doc says they "most probably will be" and
//! still get two real siblings out of it.

use std::rc::Rc;

use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{local_name, ns, Attribute, LocalName, QualName};
use markup5ever_rcdom::{Handle, Node, NodeData, RcDom, SerializableHandle};
use serde::{Deserialize, Serialize};

/// The three configurable names. An empty `tag_name` disables the whole feature (`is_enabled`) — the
/// other two fields don't matter then. Configured names are matched case-insensitively (as HTML tag and
/// attribute names always are), so any casing works, but are otherwise taken literally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AyranConfig {
    pub tag_name: String,
    pub id_attr: String,
    pub selector_attr: String,
}

impl Default for AyranConfig {
    fn default() -> Self {
        Self { tag_name: "a-x".into(), id_attr: "a-y".into(), selector_attr: "a-z".into() }
    }
}

impl AyranConfig {
    pub fn is_enabled(&self) -> bool {
        !self.tag_name.trim().is_empty()
    }
}

// ── Storage, the in-memory cache, and the admin-only commands ──────────────────────────────────────────
//
// One choice for the whole app, kept in `global_settings` (so it follows the data folder like the rest of
// it) — the same idea as `appearance.rs`'s theme/mode. Read by `markdown.rs` on *every* markdown page a
// window opens, so — also like appearance — the current value is kept in a small in-memory cache
// (`CURRENT`) rather than hit the database on every page: `init` reads it once at startup, and the two
// commands below update the cache the moment they write a change, so nothing ever reads a stale value
// without a restart. Admin-only (`admin.json`, not `user-apps.json`): this decides how *every* markdown
// file in the app renders, the same kind of whole-app rendering choice `set_appearance_rotation` already
// keeps to the admin-app alone, not a page's own business.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::app_state::AppDbState;

const TAG_KEY: &str = "ayranTag.tagName";
const ID_KEY: &str = "ayranTag.idAttr";
const SELECTOR_KEY: &str = "ayranTag.selectorAttr";
/// Kept out of the generic `set_global_setting` the same way `appearance::RESERVED_PREFIX` is.
pub const RESERVED_PREFIX: &str = "ayranTag.";

static CURRENT: Mutex<Option<AyranConfig>> = Mutex::new(None);

/// The config as of the last read or write — a fast, sync, in-memory lookup for `markdown.rs`'s own
/// rendering path, which never touches the database. Falls back to the default if `init` hasn't run yet
/// (never happens in the real app, but keeps this usable from a test with no database at hand).
pub fn current() -> AyranConfig {
    CURRENT.lock().unwrap().clone().unwrap_or_default()
}

fn remember(config: &AyranConfig) {
    *CURRENT.lock().unwrap() = Some(config.clone());
}

async fn read(pool: &sqlx::SqlitePool) -> AyranConfig {
    async fn get(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1").bind(key).fetch_optional(pool).await.ok().flatten()
    }
    let default = AyranConfig::default();
    AyranConfig {
        tag_name: get(pool, TAG_KEY).await.unwrap_or(default.tag_name),
        id_attr: get(pool, ID_KEY).await.unwrap_or(default.id_attr),
        selector_attr: get(pool, SELECTOR_KEY).await.unwrap_or(default.selector_attr),
    }
}

async fn write_one(pool: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO global_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// At start: reads what was configured (or the defaults) and remembers it, so `markdown.rs` never has to
/// wait on a database read of its own.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppDbState>();
    let config = tauri::async_runtime::block_on(read(&state.pool));
    remember(&config);
}

/// The current configuration — for the Settings page to show what's configured.
#[tauri::command]
pub async fn get_ayran_tag_config(state: tauri::State<'_, AppDbState>) -> Result<AyranConfig, String> {
    Ok(read(&state.pool).await)
}

/// Changes it. A blank `tag_name` disables the feature (`AyranConfig::is_enabled`); `id_attr`/
/// `selector_attr` may be anything (they're simply never looked at while disabled). All three are written
/// together, so the config on disk is never a mix of an old and a new choice.
#[tauri::command]
pub async fn set_ayran_tag_config(
    window: crate::window_host::CallerWindow,
    state: tauri::State<'_, AppDbState>,
    config: AyranConfig,
) -> Result<AyranConfig, String> {
    crate::window_host::require_admin(&window, "set_ayran_tag_config")?;
    write_one(&state.pool, TAG_KEY, &config.tag_name).await?;
    write_one(&state.pool, ID_KEY, &config.id_attr).await?;
    write_one(&state.pool, SELECTOR_KEY, &config.selector_attr).await?;
    remember(&config);
    Ok(config)
}

/// Applies the transform to `html` — the *inner* html of a `<body>` (what `markdown.rs`'s
/// `body_with_line_anchors` produces) — and returns the result. A no-op (returns `html` unchanged,
/// touching nothing) when the feature is disabled or `html` doesn't even contain the configured tag name
/// as a substring — the common case for every markdown file that doesn't use this feature at all, so nobody
/// pays for a parse-transform-reserialize round trip they never asked for.
pub fn apply(html: &str, config: &AyranConfig) -> String {
    if !config.is_enabled() || !html.to_ascii_lowercase().contains(&config.tag_name.to_ascii_lowercase()) {
        return html.to_string();
    }
    let rewritten = rewrite_self_closing(html, &config.tag_name);

    let context = QualName::new(None, ns!(html), local_name!("body"));
    let dom: RcDom =
        html5ever::driver::parse_fragment(RcDom::default(), Default::default(), context, vec![], false).one(rewritten);
    // A fragment parse always wraps its result in a synthetic `<html>` root (a parsing artifact of the
    // "body" context, never an element the person wrote) — verified live; its *children* are the real
    // top-level content.
    let Some(root) = dom.document.children.borrow().first().cloned() else { return html.to_string() };

    transform_subtree(&root, config);

    let mut buf = Vec::new();
    if html5ever::serialize::serialize(&mut buf, &SerializableHandle::from(root), Default::default()).is_err() {
        return html.to_string();
    }
    String::from_utf8(buf).unwrap_or_else(|_| html.to_string())
}

/// Whether `chunk`, once trimmed, is *purely* one occurrence of the ayran tag — an opening tag (whether or
/// not it's self-closing) or a closing tag — and nothing else before or after it. Used by `markdown.rs`'s
/// `body_with_line_anchors` to decide whether a top-level raw-html block is a bare ayran marker that
/// shouldn't get its own `data-line` wrapper (see that function's own doc for why the wrapper would
/// otherwise break the sibling-based pairing this whole module is built on).
pub fn is_bare_tag(chunk: &str, config: &AyranConfig) -> bool {
    let trimmed = chunk.trim();
    if trimmed.is_empty() {
        return false;
    }
    let tag_lower = config.tag_name.to_ascii_lowercase();
    if trimmed.len() == tag_lower.len() + 3 && trimmed.starts_with("</") && trimmed.ends_with('>') {
        return trimmed[2..trimmed.len() - 1].eq_ignore_ascii_case(&tag_lower);
    }
    let bytes = trimmed.as_bytes();
    if bytes.first() != Some(&b'<') {
        return false;
    }
    let name_end = 1 + tag_lower.len();
    if name_end > trimmed.len() || !trimmed.is_char_boundary(name_end) || !trimmed[1..name_end].eq_ignore_ascii_case(&tag_lower) {
        return false;
    }
    let boundary_ok = trimmed[name_end..].chars().next().is_none_or(|c| c.is_whitespace() || c == '/' || c == '>');
    if !boundary_ok {
        return false;
    }
    matches!(find_tag_end(bytes, name_end), Some(gt) if gt == bytes.len() - 1)
}

/// Turns `<TAG ... />` into the equivalent explicit empty element `<TAG ...></TAG>`, for occurrences of
/// `tag_name` only (case-insensitive) — see the module doc for why. A plain, purpose-built scan rather than
/// a general HTML parse: it only needs to find where *this one* tag's own opening syntax starts and ends
/// (respecting quoted attribute values, so a `>` or `/` inside one doesn't end the tag early), and copies
/// everything else through completely unexamined. A malformed/truncated tag (no closing `>` found) is left
/// exactly as it was — this pass only ever rewrites what it's sure about.
fn rewrite_self_closing(html: &str, tag_name: &str) -> String {
    let bytes = html.as_bytes();
    let tag_lower = tag_name.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let after_lt = i + 1;
            let name_end = after_lt + tag_lower.len();
            let name_matches = html.is_char_boundary(name_end)
                && html[after_lt..name_end.min(html.len())].eq_ignore_ascii_case(&tag_lower);
            let boundary_ok = html[name_end.min(html.len())..].chars().next().is_none_or(|c| c.is_whitespace() || c == '/' || c == '>');
            if name_matches && boundary_ok {
                if let Some(gt) = find_tag_end(bytes, name_end) {
                    let mut k = gt;
                    while k > name_end && bytes[k - 1] == b' ' {
                        k -= 1;
                    }
                    let self_closing = k > name_end && bytes[k - 1] == b'/';
                    if self_closing {
                        k -= 1; // drop the '/' itself
                        while k > name_end && bytes[k - 1] == b' ' {
                            k -= 1;
                        }
                        out.push_str(&html[i..k]);
                        out.push_str("></");
                        out.push_str(tag_name);
                        out.push('>');
                    } else {
                        out.push_str(&html[i..=gt]);
                    }
                    i = gt + 1;
                    continue;
                }
            }
        }
        let ch_len = utf8_char_len(bytes[i]);
        out.push_str(&html[i..(i + ch_len).min(html.len())]);
        i += ch_len;
    }
    out
}

/// From just past a (matched) tag name, the byte index of that tag's terminating `>` — skipping over any
/// `>` or `/` found inside a `"…"`/`'…'` quoted attribute value. `None` if the tag is never closed.
fn find_tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut j = from;
    let mut quote: Option<u8> = None;
    while j < bytes.len() {
        let b = bytes[j];
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return Some(j),
            None => {}
        }
        j += 1;
    }
    None
}

fn utf8_char_len(first_byte: u8) -> usize {
    if first_byte & 0b1000_0000 == 0 {
        1
    } else if first_byte & 0b1110_0000 == 0b1100_0000 {
        2
    } else if first_byte & 0b1111_0000 == 0b1110_0000 {
        3
    } else {
        4
    }
}

/// Post-order: every descendant subtree is transformed *before* this node's own direct children are
/// scanned for pairs — so a pair nested inside a child element (not just nested via sibling-range
/// containment, handled by `collapse_pairs` itself) is already resolved by the time it might matter here.
fn transform_subtree(node: &Handle, config: &AyranConfig) {
    for child in node.children.borrow().iter() {
        if matches!(child.data, NodeData::Element { .. }) {
            transform_subtree(child, config);
        }
    }
    collapse_pairs(node, config);
}

/// Scans `node`'s direct children for matched sibling pairs of `config.tag_name` elements (equal
/// `id_attr` values, exactly two such siblings sharing that value) and collapses each into a single
/// wrapper element holding what was between them — see the module doc for the full rule, including what's
/// left untouched. Rewrites `node.children` in place.
fn collapse_pairs(node: &Handle, config: &AyranConfig) {
    let tag_lower = config.tag_name.to_ascii_lowercase();
    let id_lower = config.id_attr.to_ascii_lowercase();

    // Group the *indices* of matching direct children by their id_attr value; keep only groups of
    // exactly two (an unmatched or ambiguous — 3+ — group is left untouched, its tags included).
    let mut by_id: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    {
        let children = node.children.borrow();
        for (idx, child) in children.iter().enumerate() {
            if let NodeData::Element { name, attrs, .. } = &child.data {
                if name.local.as_ref() == tag_lower {
                    if let Some(id_value) = find_attr(&attrs.borrow(), &id_lower) {
                        by_id.entry(id_value).or_default().push(idx);
                    }
                }
            }
        }
    }
    let ranges: Vec<(usize, usize)> = by_id.into_values().filter(|v| v.len() == 2).map(|v| (v[0], v[1])).collect();
    if ranges.is_empty() {
        return;
    }
    // A candidate that only *partially* overlaps another (crosses it, rather than nesting cleanly inside
    // or sitting fully outside it — an interleaved a<c<b<d, not a<c<d<b or a<b<c<d) is left untouched — not
    // explicitly one of the spec's ignore-cases, but there is no sensible wrapping for it, and "leave it
    // exactly where it is" is this feature's answer to every case it can't cleanly resolve. Checked against
    // *every other candidate*, not accepted-so-far only: since each id value's own range is otherwise
    // independent of which other range happened to be looked at first, deciding this any other way would
    // make the outcome depend on `by_id`'s own (unspecified) hash-map iteration order — found live, the
    // first version of this rejected only *one side* of a crossing pair depending on that order, leaving
    // the other side collapsed as if nothing were wrong with it.
    let mut accepted: Vec<(usize, usize)> =
        ranges.iter().copied().filter(|&r| !ranges.iter().any(|&other| other != r && ranges_cross(r, other))).collect();
    if accepted.is_empty() {
        return;
    }
    // Apply smallest-span-first: each collapse replaces its own [start, end] range with one new node,
    // and every still-pending range is reindexed to account for the ones removed.
    accepted.sort_by_key(|&(s, e)| e - s);
    let mut pending = accepted;
    while let Some((start, end)) = pending.first().copied() {
        collapse_one(node, start, end, config);
        let removed = end - start; // (end - start + 1) tags/content collapsed down to 1 node
        pending.remove(0);
        for r in pending.iter_mut() {
            if r.0 > end {
                r.0 -= removed;
            }
            if r.1 > end {
                r.1 -= removed;
            }
        }
    }
}

/// Whether ranges `a` and `b` partially overlap — cross — rather than being disjoint or one properly
/// containing the other.
fn ranges_cross(a: (usize, usize), b: (usize, usize)) -> bool {
    let disjoint = a.1 < b.0 || b.1 < a.0;
    let a_contains_b = a.0 <= b.0 && b.1 <= a.1;
    let b_contains_a = b.0 <= a.0 && a.1 <= b.1;
    !(disjoint || a_contains_b || b_contains_a)
}

/// Collapses direct children `[start, end]` of `node` (the two `tag_name` elements at `start`/`end`, and
/// everything between them) into one new wrapper element in their place, per the module doc's rule.
fn collapse_one(node: &Handle, start: usize, end: usize, config: &AyranConfig) {
    let selector_lower = config.selector_attr.to_ascii_lowercase();
    let id_lower = config.id_attr.to_ascii_lowercase();

    let mut children = node.children.borrow_mut();
    let between: Vec<Handle> = children[start + 1..end].to_vec();
    let first = children[start].clone();

    let (selector_value, other_attrs) = match &first.data {
        NodeData::Element { attrs, .. } => {
            let attrs = attrs.borrow();
            let selector = find_attr(&attrs, &selector_lower).unwrap_or_default();
            let kept: Vec<Attribute> = attrs
                .iter()
                .filter(|a| a.name.local.as_ref() != selector_lower && a.name.local.as_ref() != id_lower)
                .cloned()
                .collect();
            (selector, kept)
        }
        _ => (String::new(), Vec::new()),
    };
    let (tag, id, classes) = parse_selector(&selector_value);

    let mut new_attrs: Vec<Attribute> = other_attrs;
    if let Some(id) = id {
        new_attrs.push(Attribute { name: QualName::new(None, ns!(), LocalName::from("id")), value: StrTendril::from(id) });
    }
    if !classes.is_empty() {
        new_attrs.push(Attribute {
            name: QualName::new(None, ns!(), LocalName::from("class")),
            value: StrTendril::from(classes.join(" ")),
        });
    }

    let wrapper = Node::new(NodeData::Element {
        name: QualName::new(None, ns!(html), LocalName::from(tag)),
        attrs: std::cell::RefCell::new(new_attrs),
        template_contents: std::cell::RefCell::new(None),
        mathml_annotation_xml_integration_point: false,
    });
    for child in &between {
        child.parent.set(Some(Rc::downgrade(&wrapper)));
    }
    *wrapper.children.borrow_mut() = between;
    wrapper.parent.set(Some(Rc::downgrade(node)));

    children.splice(start..=end, [wrapper]);
}

fn find_attr(attrs: &[Attribute], local_lower: &str) -> Option<String> {
    attrs.iter().find(|a| a.name.local.as_ref() == local_lower).map(|a| a.value.to_string())
}

/// The `selector_attr`'s tiny microsyntax: an optional tag name, then any number of `#id`/`.class`
/// segments in any order (the *last* `#id` wins if more than one is given; every `.class` is kept, in
/// order, space-joined). An empty or tag-only string defaults the tag to `div`. Not validated against real
/// CSS selector syntax beyond this — a person typing something else just gets it taken literally as best
/// as this can, never a hard error (this is rendering, not a form to reject).
fn parse_selector(selector: &str) -> (String, Option<String>, Vec<String>) {
    let mut tag = String::new();
    let mut id: Option<String> = None;
    let mut classes: Vec<String> = Vec::new();
    let mut chars = selector.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == '#' || c == '.' {
            break;
        }
        tag.push(c);
        chars.next();
    }
    while let Some(&marker) = chars.peek() {
        chars.next();
        let mut segment = String::new();
        while let Some(&c) = chars.peek() {
            if c == '#' || c == '.' {
                break;
            }
            segment.push(c);
            chars.next();
        }
        if marker == '#' {
            if !segment.is_empty() {
                id = Some(segment);
            }
        } else if !segment.is_empty() {
            classes.push(segment);
        }
    }
    let tag = if tag.trim().is_empty() { "div".to_string() } else { tag };
    (tag, id, classes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AyranConfig {
        AyranConfig::default()
    }

    #[test]
    fn disabled_when_the_tag_name_is_empty() {
        let c = AyranConfig { tag_name: String::new(), ..cfg() };
        assert!(!c.is_enabled());
        assert_eq!(apply("<a-x a-y=\"1\"></a-x>x<a-x a-y=\"1\"></a-x>", &c), "<a-x a-y=\"1\"></a-x>x<a-x a-y=\"1\"></a-x>");
    }

    #[test]
    fn untouched_when_the_tag_never_appears() {
        assert_eq!(apply("<p>hello <em>world</em></p>", &cfg()), "<p>hello <em>world</em></p>");
    }

    #[test]
    fn a_simple_self_closing_pair_wraps_what_is_between_them() {
        let html = "<p>before</p><a-x a-y=\"1\" a-z=\"section#main.card\" data-extra=\"kept\"/><p>middle</p><a-x a-y=\"1\"/><p>after</p>";
        let out = apply(html, &cfg());
        // Attribute order (kept-as-is attributes first, then the synthesized id/class) is whatever the
        // real serializer's own attribute order happens to be — not semantically meaningful — so this
        // checks presence and the surrounding structure, not one exact order.
        assert!(out.starts_with("<p>before</p><section "), "{out}");
        assert!(out.contains("id=\"main\"") && out.contains("class=\"card\"") && out.contains("data-extra=\"kept\""), "{out}");
        assert!(out.ends_with("><p>middle</p></section><p>after</p>"), "{out}");
    }

    #[test]
    fn explicit_paired_tags_work_the_same_as_self_closing_ones() {
        let html = "<p>before</p><a-x a-y=\"1\" a-z=\"div#main\"></a-x><p>middle</p><a-x a-y=\"1\"></a-x><p>after</p>";
        assert_eq!(apply(html, &cfg()), "<p>before</p><div id=\"main\"><p>middle</p></div><p>after</p>");
    }

    #[test]
    fn no_selector_defaults_to_a_plain_div_with_no_id_or_class() {
        let html = "<a-x a-y=\"1\"/>text<a-x a-y=\"1\"/>";
        assert_eq!(apply(html, &cfg()), "<div>text</div>");
    }

    // "Left where it is" means the tag, its attributes and its position — not necessarily the exact
    // self-closing-vs-paired *syntax*: `rewrite_self_closing` (see the module doc) normalizes a
    // self-closing ayran tag into an explicit empty element *before* anything decides whether it will
    // end up matched, since that decision needs the real parsed tree either way. An untouched tag is
    // still exactly the same element with the same attributes in the same place — just always in its
    // paired-tag form afterward, the same way a browser's own devtools would show it.
    #[test]
    fn an_unmatched_tag_is_left_exactly_where_it_is() {
        let html = "<p>a</p><a-x a-y=\"1\"/><p>b</p>";
        assert_eq!(apply(html, &cfg()), "<p>a</p><a-x a-y=\"1\"></a-x><p>b</p>");
    }

    #[test]
    fn more_than_two_siblings_sharing_an_id_are_all_left_untouched() {
        let html = "<a-x a-y=\"1\"/>x<a-x a-y=\"1\"/>y<a-x a-y=\"1\"/>";
        assert_eq!(apply(html, &cfg()), "<a-x a-y=\"1\"></a-x>x<a-x a-y=\"1\"></a-x>y<a-x a-y=\"1\"></a-x>");
    }

    #[test]
    fn the_same_id_on_tags_that_are_not_siblings_is_left_untouched() {
        // The two id="1" tags are not direct siblings of one another (one is nested inside a <div>), so
        // neither is touched — even though, read loosely, "two _x elements with the same id" exist.
        let html = "<div><a-x a-y=\"1\"/></div><a-x a-y=\"1\"/>";
        assert_eq!(apply(html, &cfg()), "<div><a-x a-y=\"1\"></a-x></div><a-x a-y=\"1\"></a-x>");
    }

    #[test]
    fn nested_pairs_are_resolved_leaf_first() {
        let html = "<a-x a-y=\"1\" a-z=\"div#outer\"/><p>before</p><a-x a-y=\"2\" a-z=\"span.inner\"/><em>mid</em><a-x a-y=\"2\"/><p>after</p><a-x a-y=\"1\"/>";
        let out = apply(html, &cfg());
        assert_eq!(out, "<div id=\"outer\"><p>before</p><span class=\"inner\"><em>mid</em></span><p>after</p></div>");
    }

    #[test]
    fn different_ids_at_the_same_level_are_independent_pairs() {
        let html = "<a-x a-y=\"1\" a-z=\"div#a\"/>x<a-x a-y=\"1\"/>y<a-x a-y=\"2\" a-z=\"div#b\"/>z<a-x a-y=\"2\"/>";
        assert_eq!(apply(html, &cfg()), "<div id=\"a\">x</div>y<div id=\"b\">z</div>");
    }

    #[test]
    fn a_crossing_pair_is_left_untouched() {
        // id=1 spans [0,2], id=2 spans [1,3] — genuinely interleaved, not nested. Neither can be cleanly
        // resolved, so both pairs' tags are left exactly as they are.
        let html = "<a-x a-y=\"1\"/><a-x a-y=\"2\"/><a-x a-y=\"1\"/><a-x a-y=\"2\"/>";
        assert_eq!(apply(html, &cfg()), "<a-x a-y=\"1\"></a-x><a-x a-y=\"2\"></a-x><a-x a-y=\"1\"></a-x><a-x a-y=\"2\"></a-x>");
    }

    #[test]
    fn selector_syntax_is_parsed_tag_id_and_classes_in_any_order() {
        assert_eq!(parse_selector(""), ("div".into(), None, vec![]));
        assert_eq!(parse_selector("span"), ("span".into(), None, vec![]));
        assert_eq!(parse_selector("#main"), ("div".into(), Some("main".into()), vec![]));
        assert_eq!(parse_selector(".card"), ("div".into(), None, vec!["card".into()]));
        assert_eq!(parse_selector("section#main.card.big"), ("section".into(), Some("main".into()), vec!["card".into(), "big".into()]));
        assert_eq!(parse_selector(".card#main"), ("div".into(), Some("main".into()), vec!["card".into()]), "id and class in either order");
    }

    #[test]
    fn configured_names_are_matched_case_insensitively() {
        let c = AyranConfig { tag_name: "A-X".into(), id_attr: "A-Y".into(), selector_attr: "A-Z".into() };
        let html = "<a-x a-y=\"1\" a-z=\"div#w\"/>text<a-x a-y=\"1\"/>";
        assert_eq!(apply(html, &c), "<div id=\"w\">text</div>");
    }

    #[test]
    fn a_custom_tag_and_attribute_names_can_be_configured() {
        let c = AyranConfig { tag_name: "ayran".into(), id_attr: "pair".into(), selector_attr: "as".into() };
        let html = "<ayran pair=\"z\" as=\"p.note\"/>hi<ayran pair=\"z\"/>";
        assert_eq!(apply(html, &c), "<p class=\"note\">hi</p>");
    }

    #[test]
    fn is_bare_tag_recognises_only_a_chunk_that_is_exactly_one_ayran_tag() {
        let c = cfg();
        assert!(is_bare_tag("<a-x a-y=\"1\" a-z=\"div#w\"/>", &c));
        assert!(is_bare_tag("  <a-x a-y=\"1\"/>\n", &c), "surrounding whitespace is trimmed");
        assert!(is_bare_tag("<a-x a-y=\"1\">", &c), "a non-self-closing bare opening tag counts too");
        assert!(is_bare_tag("</a-x>", &c));
        assert!(!is_bare_tag("<a-x a-y=\"1\"/>text", &c), "something after it");
        assert!(!is_bare_tag("text<a-x a-y=\"1\"/>", &c), "something before it");
        assert!(!is_bare_tag("<a-xyz/>", &c), "a different tag that merely starts with the same prefix");
        assert!(!is_bare_tag("<p>hi</p>", &c));
        assert!(!is_bare_tag("", &c));
    }

    #[test]
    fn quoted_attribute_values_can_contain_slash_and_angle_bracket_like_text() {
        let html = "<a-x a-y=\"1\" a-z=\"div#w\" data-note=\"a/b&gt;c\"/>x<a-x a-y=\"1\"/>";
        let out = apply(html, &cfg());
        assert!(out.contains("id=\"w\"") && out.contains("data-note=\"a/b&gt;c\"") && out.ends_with(">x</div>"), "{out}");
    }
}
