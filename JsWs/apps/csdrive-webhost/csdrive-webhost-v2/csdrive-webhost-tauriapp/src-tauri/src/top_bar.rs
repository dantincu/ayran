//! What a page's own top bar shows besides its four buttons (Back, Suspend, Close tab, Hide — drawn
//! by the page itself, see CLAUDE.md's "The top bar"): the tab's two rows of formatted text, its own
//! tags, and the root it's showing (with the root's own tags) — read-only, so a page needs no
//! JavaScript of its own to display them. Rendered here, server-side, as one HTML string
//! (`TabInitResponse.top_bar_html` and `update_tab_resource`'s response) — a page just assigns it to
//! an element's `innerHTML`. The classes it uses (`csdrive-tb-*`) are styled by a CSS code snippet
//! (`code_snippets.rs`), so every page gets a consistent look for free.
//!
//! Also decides whether the bar should start **hidden**: `tabs.top_bar_hidden` (nullable) is `1` once
//! the person has closed it, `0` once the admin-app's "Show the top bar" has overridden that, and
//! `NULL` — the ordinary case — follows the global `topBar.autohide` setting (on by default).

use sqlx::{Row, SqlitePool};

use crate::secondary_windows::{TabText, TabTextSpan};

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

async fn bool_setting(pool: &SqlitePool, key: &str, default: bool) -> bool {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1")
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap_or(None);
    match value.as_deref() {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => default,
    }
}

/// The global default a tab's top bar follows when the person hasn't explicitly closed or the
/// admin-app hasn't explicitly shown it (`topBar.autohide` in `global_settings`; on by default).
pub async fn autohide_default(pool: &SqlitePool) -> bool {
    bool_setting(pool, "topBar.autohide", true).await
}

fn row_html(spans: &[TabTextSpan]) -> String {
    let mut out = String::new();
    for (i, span) in spans.iter().enumerate() {
        if i > 0 {
            out.push_str("<span class=\"csdrive-tb-bullet\">\u{2022}</span>");
        }
        let mut style = String::new();
        if span.bold {
            style.push_str("font-weight:700;");
        }
        if span.italic {
            style.push_str("font-style:italic;");
        }
        let class = if span.mono { " class=\"csdrive-tb-mono\"" } else { "" };
        let style_attr = if style.is_empty() { String::new() } else { format!(" style=\"{style}\"") };
        out.push_str(&format!("<span{class}{style_attr}>{}</span>", escape(&span.text)));
    }
    out
}

async fn tags_html(pool: &SqlitePool, guid: &str) -> String {
    let rows = sqlx::query("SELECT text, fg_color, bg_color FROM window_tags WHERE guid = ?1 ORDER BY sort_order, id")
        .bind(guid)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from("<span class=\"csdrive-tb-tags\">");
    for row in rows {
        let text: String = row.get("text");
        let fg: String = row.get("fg_color");
        let bg: String = row.get("bg_color");
        out.push_str(&format!("<span class=\"csdrive-tb-tag\" style=\"color:{};background:{}\">{}</span>", escape(&fg), escape(&bg), escape(&text)));
    }
    out.push_str("</span>");
    out
}

/// The root a Notes tab's resource id names, as `(tag guid, display name)` — mirrors the frontend's
/// `rootOfTab` (`src/lib/rootTags.ts`), so the two agree on what a tab's root is. `None` for a tab
/// that isn't Notes', or a Notes tab that isn't showing a source yet (the home page, notebooks…).
async fn root_of(pool: &SqlitePool, window_relative_path: &str, resource_id: &str) -> Option<(String, String)> {
    if window_relative_path != "system:notes" {
        return None;
    }
    let query = resource_id.split_once('?').map(|(_, q)| q).unwrap_or("");
    let source = query.split('&').find_map(|part| part.strip_prefix("s="))?;
    let source = percent_encoding::percent_decode_str(source).decode_utf8_lossy().to_string();
    if let Some(id) = source.strip_prefix("local:") {
        let name = if id == "user" {
            "User folder".to_string()
        } else {
            crate::picked_roots::label_of(pool, id).await.unwrap_or_else(|| id.to_string())
        };
        Some((format!("root:{id}"), name))
    } else if let Some(user_id) = source.strip_prefix("filen:") {
        let email: Option<String> = match user_id.parse::<i64>() {
            Ok(id) => sqlx::query_scalar("SELECT email FROM filen_accounts WHERE user_id = ?1").bind(id).fetch_one(pool).await.unwrap_or(None),
            Err(_) => None,
        };
        Some((format!("root:filen:{user_id}"), email.unwrap_or_else(|| format!("Filen account {user_id}"))))
    } else {
        None
    }
}

/// Builds the markup for a tab: its two rows of text, its own tags (unless `topBar.hideLabels`), and
/// the root it's showing with the root's own tags (unless `topBar.hideRoot`). Empty string for a tab
/// with nothing to show yet (`tab_text` is `None` until the app's first `update_tab_resource`).
pub async fn render_html(pool: &SqlitePool, window_relative_path: &str, resource_id: &str, tab_guid: &str, tab_text: Option<&TabText>) -> String {
    let Some(tab_text) = tab_text else { return String::new() };
    let hide_labels = bool_setting(pool, "topBar.hideLabels", false).await;
    let hide_root = bool_setting(pool, "topBar.hideRoot", false).await;

    let mut html = String::from("<span class=\"csdrive-tb-info\">");
    html.push_str(&format!("<span class=\"csdrive-tb-row\">{}</span>", row_html(&tab_text.first_row)));
    if !tab_text.second_row.is_empty() {
        html.push_str(&format!("<span class=\"csdrive-tb-row\">{}</span>", row_html(&tab_text.second_row)));
    }
    if !hide_labels {
        html.push_str(&tags_html(pool, tab_guid).await);
    }
    if !hide_root {
        if let Some((root_guid, name)) = root_of(pool, window_relative_path, resource_id).await {
            html.push_str("<span class=\"csdrive-tb-root\">");
            html.push_str(&format!("<span class=\"csdrive-tb-root-name\">{}</span>", escape(&name)));
            if !hide_labels {
                html.push_str(&tags_html(pool, &root_guid).await);
            }
            html.push_str("</span>");
        }
    }
    html.push_str("</span>");
    html
}

/// Whether the tab's top bar should start hidden: its own persisted choice (`tabs.top_bar_hidden`),
/// or, absent one, the global autohide default.
pub async fn hidden(pool: &SqlitePool, tab_guid: &str) -> bool {
    let stored: Option<i64> = sqlx::query_scalar("SELECT top_bar_hidden FROM tabs WHERE guid = ?1").bind(tab_guid).fetch_one(pool).await.unwrap_or(None);
    match stored {
        Some(1) => true,
        Some(0) => false,
        _ => autohide_default(pool).await,
    }
}

/// Persists whether the tab's top bar is hidden: `true` when the person closes it (from the page's own
/// × button), `false` when the admin-app's "Show the top bar" overrides that. There is no "reset to
/// the global default" today — only close and show.
pub async fn set_hidden(pool: &SqlitePool, tab_guid: &str, hidden: bool) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET top_bar_hidden = ?1 WHERE guid = ?2")
        .bind(if hidden { 1 } else { 0 })
        .bind(tab_guid)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears every tab's persisted "closed" state — the admin-app's global "Show the top bar for every
/// open window" button.
pub async fn show_every_tab(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET top_bar_hidden = 0").execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The html and hidden-ness a tab's top bar should show right now, computed straight from the
/// database — used wherever a `TabInitResponse` or `update_tab_resource`'s answer is built, so the two
/// never disagree. `(String::new(), true)` for a tab that no longer exists.
pub async fn compute(pool: &SqlitePool, tab_guid: &str) -> (String, bool) {
    let row = sqlx::query(
        "SELECT w.relative_path AS window_path, t.resource_id AS resource_id, t.tab_text AS tab_text
         FROM tabs t JOIN secondary_windows w ON w.guid = t.window_guid WHERE t.guid = ?1",
    )
    .bind(tab_guid)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let Some(row) = row else { return (String::new(), true) };
    let window_path: String = row.get("window_path");
    let resource_id: String = row.get("resource_id");
    let tab_text: Option<TabText> = row.get::<Option<String>, _>("tab_text").and_then(|json| serde_json::from_str(&json).ok());
    let html = render_html(pool, &window_path, &resource_id, tab_guid, tab_text.as_ref()).await;
    let hidden = hidden(pool, tab_guid).await;
    (html, hidden)
}

/// The CSS every page needs to make sense of `render_html`'s markup — a code snippet
/// (`code_snippets.rs`), applied automatically by every web app and system app.
pub const TOP_BAR_INFO_CSS: &str = "\
.csdrive-tb-info { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font: 13px system-ui, sans-serif; min-width: 0; }
.csdrive-tb-row { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
.csdrive-tb-bullet { margin: 0 5px; opacity: 0.6; }
.csdrive-tb-mono { font-family: ui-monospace, monospace; }
.csdrive-tb-tags, .csdrive-tb-root { display: inline-flex; align-items: center; gap: 4px; }
.csdrive-tb-root { padding-left: 8px; border-left: 1px solid rgba(128,128,128,0.4); opacity: 0.85; }
.csdrive-tb-root-name { font-size: 12px; }
.csdrive-tb-tag { font-size: 11px; padding: 1px 6px; border-radius: 8px; line-height: 1.5; }
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_covers_the_five_characters_html_needs() {
        assert_eq!(escape("<a href=\"x\">&</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    }

    #[test]
    fn row_html_bullets_between_spans_and_keeps_flags() {
        let spans = vec![
            TabTextSpan { text: "A".into(), bold: true, italic: false, mono: false },
            TabTextSpan { text: "b".into(), bold: false, italic: true, mono: true },
        ];
        let html = row_html(&spans);
        assert!(html.contains("csdrive-tb-bullet"));
        assert!(html.contains("font-weight:700"));
        assert!(html.contains("font-style:italic"));
        assert!(html.contains("csdrive-tb-mono"));
    }

    /// A fresh `data.db` under an isolated OS temp dir — `name` keeps concurrently-running tests from
    /// racing on the same file (as `secondary_windows`' own `test_pool` does).
    async fn test_pool(name: &str) -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("csdrive-top-bar-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pool = crate::secondary_windows::init_db(&dir).await.unwrap();
        sqlx::query("CREATE TABLE picked_roots (id TEXT, path TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE filen_accounts (user_id INTEGER PRIMARY KEY, email TEXT NOT NULL)").execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn root_of_recognises_a_device_root_and_a_filen_account_agreeing_with_the_frontends_own_rootoftab() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("root-of").await;
            sqlx::query("INSERT INTO picked_roots (id, path, label, created_at) VALUES ('abc123', '/some/folder', 'My Documents', 1)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO filen_accounts (user_id, email) VALUES (42, 'person@example.com')").execute(&pool).await.unwrap();

            // Not a Notes window at all.
            assert!(root_of(&pool, "asdf/index.html", "asdf/index.html?s=local:user").await.is_none());
            // A Notes tab with no source yet (the home page).
            assert!(root_of(&pool, "system:notes", "system:notes?v=home").await.is_none());

            // The user folder.
            let (guid, name) = root_of(&pool, "system:notes", "system:notes?s=local:user&p=%2F").await.unwrap();
            assert_eq!(guid, "root:user");
            assert_eq!(name, "User folder");

            // A picked folder: named by its own label, tagged `root:<id>` — the same guid `rootTagGuid`
            // (`src/lib/rootTags.ts`) builds for it on the frontend.
            let (guid, name) = root_of(&pool, "system:notes", "system:notes?s=local:abc123&p=").await.unwrap();
            assert_eq!(guid, "root:abc123");
            assert_eq!(name, "My Documents");

            // A Filen account: named by its email, tagged `root:filen:<id>` (`filenRootTagGuid`).
            let (guid, name) = root_of(&pool, "system:notes", "system:notes?s=filen:42&b=0&p=").await.unwrap();
            assert_eq!(guid, "root:filen:42");
            assert_eq!(name, "person@example.com");
        });
    }

    #[test]
    fn render_html_includes_the_root_and_its_tags_unless_hidden() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("render-html").await;
            let text = TabText { first_row: vec![TabTextSpan { text: "Book".into(), bold: true, italic: false, mono: false }], second_row: vec![] };

            let html = render_html(&pool, "system:notes", "system:notes?s=local:user&p=", "tab1", Some(&text)).await;
            assert!(html.contains("Book"));
            assert!(html.contains("csdrive-tb-root"));
            assert!(html.contains("User folder"));

            // `topBar.hideRoot` drops the whole root section.
            sqlx::query("CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO global_settings (key, value) VALUES ('topBar.hideRoot', '1')").execute(&pool).await.unwrap();
            let html = render_html(&pool, "system:notes", "system:notes?s=local:user&p=", "tab1", Some(&text)).await;
            assert!(html.contains("Book"));
            assert!(!html.contains("csdrive-tb-root"));

            // No label at all: nothing to show.
            assert_eq!(render_html(&pool, "system:notes", "system:notes?v=home", "tab1", None).await, "");
        });
    }
}
