//! The name of the one JavaScript global `markdown.rs`'s own bootstrap script (`BOOTSTRAP`) creates on a
//! markdown file's page when it's opened as a web app — `window.<name>.events.onTabInitialized` (see that
//! module's own doc comment, and CLAUDE.md's "Who creates tabs", for what it's there for and why it lives
//! under a namespace object rather than a bare `window` leaf). Hardcoded as `window.ayran` the first time
//! it was built; **asked for directly as a follow-up**, so it can be renamed away from a name a person's
//! own page — or another injected code snippet — might already be using for something else: "instead of
//! simply hardcoding it, let's make it configurable through the app settings in the admin app. The default
//! still will be 'ayran'."
//!
//! The exact same shape as `ayran_tags.rs`'s own `AyranConfig` storage, just for a single string instead
//! of three: one choice for the whole app, kept in `global_settings` (so it follows the data folder like
//! everything else there), cached in memory (`CURRENT`) so `markdown.rs`'s rendering path — hit on every
//! markdown page a window opens — never touches the database to find it. **Admin-only**
//! (`get_/set_ayran_global_name`, `admin.json`, not `user-apps.json`): this decides the shape of *every*
//! markdown web app's own global JS surface, the same whole-app rendering choice `ayranTag.*` already is.
//!
//! **Unlike the ayran *tag*'s own `tag_name`, this one can never be blanked to "disable" anything** — the
//! global itself is core plumbing (`onTabInitialized`'s own cache-and-replay mechanism), not an optional
//! feature a markdown file opts into, so there is always a name for it; `set_ayran_global_name` refuses
//! anything that isn't a real, unquoted JavaScript identifier (`is_valid_identifier`), since the name is
//! spliced directly into `window.<name>` in the bootstrap script's own source, never through a
//! `window['...']` lookup that could tolerate an arbitrary string.
//!
//! **The substitution is scoped to the bootstrap script's own text, never the whole rendered page.**
//! `markdown.rs`'s `render_page` takes the configured name and does `BOOTSTRAP.replace("ayran", name)` —
//! deliberately *not* a replace over the final, assembled page (title and body included): a person's own
//! markdown can perfectly well contain the literal word "ayran" (it's a product name in its own right,
//! unrelated to this app's feature), and rewriting that would be a real, silent content corruption bug for
//! no reason connected to what this setting is actually for. Every occurrence of the substring "ayran"
//! inside `BOOTSTRAP` itself — the three live `window.ayran...` statements and the handful of comments that
//! mention the same namespace by name — belongs to this one feature and nothing else (confirmed directly:
//! `BOOTSTRAP`'s own source has no other use of the word), so replacing all of them together, including in
//! its comments, is correct and keeps the shipped comment text accurate to whatever name is actually
//! configured.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::app_state::AppDbState;

const NAME_KEY: &str = "ayranGlobal.name";
/// Kept out of the generic `set_global_setting` the same way `ayran_tags::RESERVED_PREFIX` is.
pub const RESERVED_PREFIX: &str = "ayranGlobal.";

pub const DEFAULT_NAME: &str = "ayran";

static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// The name as of the last read or write — a fast, sync, in-memory lookup for `markdown.rs`'s own rendering
/// path, which never touches the database. Falls back to the default if `init` hasn't run yet (never
/// happens in the real app, but keeps this usable from a test with no database at hand).
pub fn current() -> String {
    CURRENT.lock().unwrap().clone().unwrap_or_else(|| DEFAULT_NAME.to_string())
}

fn remember(name: &str) {
    *CURRENT.lock().unwrap() = Some(name.to_string());
}

async fn read(pool: &sqlx::SqlitePool) -> String {
    sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1")
        .bind(NAME_KEY)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_NAME.to_string())
}

async fn write(pool: &sqlx::SqlitePool, name: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO global_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(NAME_KEY)
        .bind(name)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// At start: reads what was configured (or the default) and remembers it, so `markdown.rs` never has to
/// wait on a database read of its own.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppDbState>();
    let name = tauri::async_runtime::block_on(read(&state.pool));
    remember(&name);
}

/// A real, unquoted JavaScript identifier — what `window.<name>` needs to be, written literally into the
/// bootstrap script's source rather than through a `window['...']` lookup. The first character is an ASCII
/// letter, `_` or `$`; every later one may also be an ASCII digit. Capped at a sane length so nothing
/// absurd ever lands in a page's own `<script>` tag.
pub fn is_valid_identifier(name: &str) -> bool {
    if name.is_empty() || name.len() > 60 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The current name — for the Settings page to show what's configured.
#[tauri::command]
pub async fn get_ayran_global_name(state: tauri::State<'_, AppDbState>) -> Result<String, String> {
    Ok(read(&state.pool).await)
}

/// Changes it. Refused — with nothing written — when it isn't a valid bare JavaScript identifier (above).
#[tauri::command]
pub async fn set_ayran_global_name(
    window: crate::window_host::CallerWindow,
    state: tauri::State<'_, AppDbState>,
    name: String,
) -> Result<String, String> {
    crate::window_host::require_admin(&window, "set_ayran_global_name")?;
    let name = name.trim().to_string();
    if !is_valid_identifier(&name) {
        return Err("Must be a plain JavaScript identifier: letters, digits, '_' or '$', not starting with a digit.".to_string());
    }
    write(&state.pool, &name).await?;
    remember(&name);
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_ayran() {
        assert_eq!(DEFAULT_NAME, "ayran");
        assert!(is_valid_identifier(DEFAULT_NAME));
    }

    #[test]
    fn valid_identifiers_are_accepted_and_malformed_ones_are_not() {
        assert!(is_valid_identifier("ayran"));
        assert!(is_valid_identifier("_private"));
        assert!(is_valid_identifier("$csdrive"));
        assert!(is_valid_identifier("a1"));
        assert!(is_valid_identifier(&"a".repeat(60)));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("1ayran"));
        assert!(!is_valid_identifier("a-x"));
        assert!(!is_valid_identifier("a.b"));
        assert!(!is_valid_identifier("a b"));
        assert!(!is_valid_identifier(&"a".repeat(61)));
    }
}
