//! A notebook's own **viewer script**: a plain JavaScript file, chosen per notebook, inserted into the DOM
//! of every Note Viewer and markdown/html File Viewer page shown for a file inside that notebook's own
//! folder (its subfolders included) — see CLAUDE.md, "A notebook's own viewer script". Notebooks are a
//! frontend-only concept (`notes.notebooks`, kept in Notes' own `app_state` — see `notebooks.ts`); this
//! module reads that same row directly, by SQL, rather than through a round trip to the frontend, so the
//! one choke point every tab's `codeSnippets` already passes through (`secondary_windows::fill_origin`) can
//! resolve it fresh, for any tab, with no new plumbing through the many "open a file as a web app" commands
//! — a link followed inside a page picks up its own notebook's script too, for free, since `fill_origin`
//! already re-derives the shown page's real location on every call. The script runs with exactly the rights
//! the page itself has — never more, never less — the same as a `<script>` tag the person wrote into the
//! file by hand would (never for the User Action page, a different, separately designed mechanism).

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use crate::code_snippets::{CodeSnippet, SnippetType};
use crate::files_cache::Cache;
use crate::fs_scope::FsScope;
use crate::secondary_windows::FilenOrigin;

const NOTES_APP_ID: &str = "system:notes";
const NOTEBOOKS_KEY: &str = "notes.notebooks";

/// Only what's needed from a listed notebook entry (`notebooks.ts`'s `NotebookEntry`) to find which one
/// contains a place — mirrors the frontend's own `notebookContaining` exactly, so the two always agree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotebookEntryRow {
    source_id: String,
    folder: String,
}

/// Where the notebook's own script is (`noteViewerScript.ts`'s `NoteViewerScript`): `{SourceId, Path}`, the
/// same shape a User Action page's own setting has (`[user-action].json`) — the script can be anywhere the
/// person points to, not necessarily the notebook's own source.
#[derive(Debug, Deserialize)]
struct ScriptRef {
    #[serde(rename = "SourceId")]
    source_id: String,
    #[serde(rename = "Path")]
    path: String,
}

#[derive(Debug, Deserialize)]
struct ScriptFile {
    #[serde(rename = "Script")]
    script: Option<ScriptRef>,
}

/// Mirrors `userAction.ts`'s `notebookContaining`: among the notebooks listed for `source_id`, the
/// innermost one whose own folder contains `folder` (its own root included) — both trimmed of leading and
/// trailing slashes before comparing, the same way the frontend does, so a Filen path's leading `/` never
/// throws the comparison off. `None` when `notes.notebooks` is absent, unreadable, or nothing matches.
async fn notebook_containing(pool: &SqlitePool, source_id: &str, folder: &str) -> Option<(String, String)> {
    let value: String = sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = ?1 AND key = ?2")
        .bind(NOTES_APP_ID)
        .bind(NOTEBOOKS_KEY)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    let list: Vec<NotebookEntryRow> = serde_json::from_str(&value).ok()?;
    pick_notebook(&list, source_id, folder).map(|nb_folder| (source_id.to_string(), nb_folder))
}

/// The pure half of `notebook_containing` — no SQL, so it's directly testable: among `list`'s entries for
/// `source_id`, the innermost whose own folder contains `folder` (its own root included), both trimmed of
/// leading/trailing slashes before comparing (the same way the frontend's own `notebookContaining` does, so
/// a Filen path's leading `/` never throws the comparison off).
fn pick_notebook(list: &[NotebookEntryRow], source_id: &str, folder: &str) -> Option<String> {
    let place = folder.trim_matches('/');
    let mut best: Option<(String, usize)> = None; // (the notebook's own folder, its trimmed length)
    for nb in list {
        if nb.source_id != source_id {
            continue;
        }
        let root = nb.folder.trim_matches('/');
        let inside = root.is_empty() || place == root || place.starts_with(&format!("{root}/"));
        if !inside {
            continue;
        }
        let better = match &best {
            None => true,
            Some((_, len)) => root.len() > *len,
        };
        if better {
            best = Some((nb.folder.clone(), root.len()));
        }
    }
    best.map(|(folder, _)| folder)
}

/// Reads a small file given a frontend-style `source_id` (`local:<rootId>` or `filen:<userId>` — never a
/// branch) and a path relative to it: the same two storages a notebook, or a script reference inside its
/// setting file, can name.
async fn read_from_source(app: &AppHandle, source_id: &str, path: &str) -> Result<Vec<u8>, String> {
    if let Some(root_id) = source_id.strip_prefix("local:") {
        let scope = app.state::<FsScope>();
        let real = scope.check_in(root_id, path, true)?;
        std::fs::read(&real).map_err(|e| e.to_string())
    } else if let Some(rest) = source_id.strip_prefix("filen:") {
        let user_id: u64 = rest.parse().map_err(|_| format!("\"{source_id}\" isn't a Filen source id."))?;
        let cache = app.state::<Cache>();
        let remote = crate::filen_cache::prepare(app, &cache, user_id).await?;
        cache.read(&remote, user_id as i64, None, path).await
    } else {
        Err(format!("Unknown source: \"{source_id}\"."))
    }
}

/// The folder a path is in (trimmed of slashes on both ends), given either shape a resolved page's own path
/// can have: a local one with no leading slash, or a Filen one with one.
fn folder_of(path: &str) -> String {
    path.trim_start_matches('/').rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default()
}

/// Resolves `relative` (which may begin with one or more `../` segments) against `base_folder`, back to a
/// path from the storage's own root — the Rust counterpart of the frontend's `resolveFolderRelative`
/// (`lib/relativePath.ts`): the viewer script's own `Path` is now stored relative to the *notebook's* own
/// root folder, not the source's, so this is needed before reading the real file.
fn resolve_folder_relative(base_folder: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in base_folder.split('/').chain(relative.split('/')) {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// The notebook's own viewer script to inject for a page at `storage`/`root`/`filen`/`path` (the same four
/// a `TabInitResponse` already carries), if there is a listed notebook containing it and it has one
/// configured. Never an error: a missing or unreadable script, or no containing notebook at all, is simply
/// `None` — the same as the page having nothing extra to apply.
pub(crate) async fn snippet_for(app: &AppHandle, pool: &SqlitePool, storage: &str, root: Option<&str>, filen: Option<&FilenOrigin>, path: &str) -> Option<CodeSnippet> {
    let source_id = match storage {
        "UserFolder" => "local:user".to_string(),
        "DeviceFolder" => {
            let (root_id, _) = crate::notes_pages::split_root(root?).ok()?;
            format!("local:{root_id}")
        }
        "FilenCloud" => format!("filen:{}", filen?.account_id),
        _ => return None, // `Bundled` (a system app's own page) has no "folder" of its own
    };
    let (notebook_source_id, notebook_folder) = notebook_containing(pool, &source_id, &folder_of(path)).await?;

    let internals = &crate::config::get().notes.internals.notebook;
    let internals_index = format!("{:0width$}", internals.from, width = internals.digits);
    let script_file_name = &crate::config::get().notes.files.note_viewer_script;
    let trimmed_folder = notebook_folder.trim_matches('/');
    let config_path =
        if trimmed_folder.is_empty() { format!("{internals_index}/{script_file_name}") } else { format!("{trimmed_folder}/{internals_index}/{script_file_name}") };

    let config_text = String::from_utf8(read_from_source(app, &notebook_source_id, &config_path).await.ok()?).ok()?;
    let script_ref = serde_json::from_str::<ScriptFile>(&config_text).ok()?.script?;

    // The script's own `Path` is relative to the *notebook's* own root folder only when it's genuinely in
    // the same source as the notebook (`NoteViewerScriptModal.tsx`'s own `choose` writes it the identical
    // way) — a script in a different source has no meaningful "relative to this notebook" address, and
    // keeps the plain, source-root-absolute form it always had.
    let resolved_path =
        if script_ref.source_id == notebook_source_id { resolve_folder_relative(&notebook_folder, &script_ref.path) } else { script_ref.path.clone() };

    let code = String::from_utf8(read_from_source(app, &script_ref.source_id, &resolved_path).await.ok()?).ok()?;
    Some(CodeSnippet { code, kind: SnippetType::Javascript })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(source_id: &str, folder: &str) -> NotebookEntryRow {
        NotebookEntryRow { source_id: source_id.to_string(), folder: folder.to_string() }
    }

    #[test]
    fn folder_of_strips_a_leading_filen_slash_and_the_file_name() {
        assert_eq!(folder_of("nb-test/999/0-Hello[note].md"), "nb-test/999");
        assert_eq!(folder_of("/nb-test/readme.md"), "nb-test");
        assert_eq!(folder_of("readme.md"), "");
        assert_eq!(folder_of("/readme.md"), "");
    }

    #[test]
    fn innermost_containing_notebook_wins_and_a_root_notebook_matches_everything() {
        let list = vec![entry("local:user", ""), entry("local:user", "nb"), entry("local:user", "nb/deep")];
        assert_eq!(pick_notebook(&list, "local:user", "nb/deep/file.md"), Some("nb/deep".to_string()));
        assert_eq!(pick_notebook(&list, "local:user", "nb/other.md"), Some("nb".to_string()));
        assert_eq!(pick_notebook(&list, "local:user", "outside.md"), Some("".to_string())); // the root notebook catches everything else
    }

    #[test]
    fn a_different_source_never_matches() {
        let list = vec![entry("filen:1", "")];
        assert_eq!(pick_notebook(&list, "local:user", "anything.md"), None);
    }

    #[test]
    fn resolve_folder_relative_handles_plain_dotdot_and_empty_segments() {
        assert_eq!(resolve_folder_relative("nb", "scripts"), "nb/scripts");
        assert_eq!(resolve_folder_relative("nb/deep", "../scripts"), "nb/scripts");
        assert_eq!(resolve_folder_relative("nb", "../outside"), "outside");
        assert_eq!(resolve_folder_relative("nb", ""), "nb");
        assert_eq!(resolve_folder_relative("", "scripts"), "scripts");
        assert_eq!(resolve_folder_relative("nb", "."), "nb");
    }

    #[test]
    fn a_leading_or_trailing_slash_on_either_side_never_throws_off_the_match() {
        let list = vec![entry("filen:42", "/nb-test/")];
        assert_eq!(pick_notebook(&list, "filen:42", "/nb-test/sub/file.md"), Some("/nb-test/".to_string()));
        assert_eq!(pick_notebook(&list, "filen:42", "nb-test-other/file.md"), None); // a sibling with a shared prefix doesn't match
    }
}
