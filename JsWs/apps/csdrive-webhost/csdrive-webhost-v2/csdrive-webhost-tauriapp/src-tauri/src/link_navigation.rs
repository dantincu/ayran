//! **Links between pages of web apps.** A web app's window never moves itself (see `lock_down_navigation`): a click on a link
//! to another page of the app's own storage — an anchor with a path (and, perhaps, a query), a `form` sent by `GET`,
//! `window.open`, `history.pushState('…')` — reaches the window's navigation rule as a *request* (`Nav::Request`). The
//! window stays where it is, and this module asks the person, in a native box that belongs to the window:
//!
//! - **what the link is** — its type (a web page, a markdown document, a note, something else), its path, and where it is
//!   (the user folder, a folder of the device, a Filen account and branch);
//! - **what to do with it** — open it **in the same tab** (the tab now shows that page), **in a new tab** (of the same tab
//!   group; it becomes the window's current tab), **copy its address** to the OS clipboard or to the app's own, or cancel.
//!   A native box has at most three buttons (on Android too), so the choices are asked in steps, each with **Cancel** as its
//!   last button (a box closed with its X or Esc answers as its last button does): *Open… / Copy… / Cancel*, then *In this
//!   tab / In a new tab / Cancel* or *To the clipboard / To the app's clipboard / Cancel*. A link that can't be opened in a
//!   window (a picture, a folder) goes straight to the copying.
//!
//! **A note's address** (`/Book/001?note`: the path of its short folder, the query key `note`) is opened like a page: its
//! markdown file — the one in that folder whose name ends with `[note].md` — is looked for in the storage (the user folder, a
//! picked folder, a Filen account or branch) when the person chooses to open it, and the tab shows *that* page.
//!
//! **Addresses.** The browser has already resolved a relative link against the page's own address, so a link is relative to
//! the file that was opened as a web app. An **absolute** path (`/notes/a.md`) is, for a page of a picked folder or a Filen
//! account, relative to *that storage's root* (the folder, the drive — not the user folder the browser took it for): the
//! address is put back under the page's own `@device/<root>` or `@filen/<user>/<branch>` prefix. A link can't lead out of
//! the storage its page is in (another folder, account or branch): that is refused.
//!
//! The address the prompt shows — and copies — is the path in that storage, with its query: `/docs/a.md`,
//! `/Projects/01?note`. A query with the key `note` makes the link a **note**'s (not a folder's or a file's).
//!
//! One question is shown at a time (a page that clicks its own links in a loop gets one box, not a pile); a request that
//! arrives while one is up is dropped.

use std::sync::atomic::{AtomicBool, Ordering};

use percent_encoding::percent_decode_str;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::notes_pages::{is_page_file, parse_special, Special};

/// Whether a question is being asked. Not persisted: it only matters while the box is up.
static ASKING: AtomicBool = AtomicBool::new(false);

/// What a link leads to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// A path with the query key `note`: a note (see the notes strategy), not the path of a folder or a file.
    Note,
    Html,
    Markdown,
    /// Anything else: a folder, an image, a text file…
    Other,
}

impl LinkKind {
    fn label(self) -> &'static str {
        match self {
            LinkKind::Note => "Note",
            LinkKind::Html => "Web page (HTML)",
            LinkKind::Markdown => "Markdown document",
            LinkKind::Other => "File or folder",
        }
    }

    /// Whether a window can show it: only the pages a window can be at (a note is its markdown).
    fn opens_in_a_tab(self) -> bool {
        matches!(self, LinkKind::Html | LinkKind::Markdown | LinkKind::Note)
    }
}

/// The storage a page lives in: the user folder, a folder the person picked, or a Filen account (and branch).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Space {
    User,
    Device(String),
    Filen { user_id: u64, branch: Option<i64> },
}

fn decoded(path: &str) -> String {
    percent_decode_str(path).decode_utf8_lossy().to_string()
}

/// The storage of an address's (percent-decoded) path, the path in it (with a leading slash), and the prefix that puts a path
/// of that storage back under it (`` for the user folder). An address in the reserved `/@…` space that names nothing valid is
/// an error.
fn space_of(path: &str) -> Result<(Space, String, String), String> {
    match parse_special(path) {
        None => Ok((Space::User, path.to_string(), String::new())),
        Some(Err(())) => Err("That address isn't one of this app's pages.".to_string()),
        Some(Ok(Special::Device { root, path })) => Ok((Space::Device(root.clone()), format!("/{path}"), format!("/@device/{root}"))),
        Some(Ok(Special::Filen { user_id, branch, path })) => {
            let prefix = format!("/@filen/{user_id}/{}", branch.map_or_else(|| "-".to_string(), |b| b.to_string()));
            Ok((Space::Filen { user_id, branch }, path, prefix))
        }
    }
}

/// The address the window is to be taken to for a link to `target` from the page at `current` (both addresses of this
/// app's own pages, as the webview has them): the browser's own resolution of it, except that an absolute path of a page in a
/// picked folder or a Filen account is put back under that storage. An error when the link leaves the storage.
pub(crate) fn resolve(current: &Url, target: &Url) -> Result<Url, String> {
    let (own, _, prefix) = space_of(&decoded(current.path()))?;
    let (there, _, _) = space_of(&decoded(target.path()))?;
    let path = if there == Space::User && own != Space::User {
        // The browser took an absolute path for one of the user folder; for this page it is relative to its storage's root.
        format!("{prefix}{}", target.path())
    } else if there != own {
        return Err("A link can't lead out of the folder or account its page is in.".to_string());
    } else {
        target.path().to_string()
    };
    let mut url = current.clone();
    url.set_path(&path);
    url.set_query(target.query());
    url.set_fragment(None);
    Ok(url)
}

/// What kind of thing an address (already resolved) names.
pub(crate) fn classify(url: &Url) -> LinkKind {
    let has_note_key = url.query_pairs().any(|(key, _)| key == "note");
    let path = decoded(url.path()).to_ascii_lowercase();
    if has_note_key {
        LinkKind::Note
    } else if !is_page_file(&path) {
        LinkKind::Other
    } else if path.ends_with(".md") || path.ends_with(".markdown") {
        LinkKind::Markdown
    } else {
        LinkKind::Html
    }
}

/// The address as a person writes it, and pastes it into a "Go to a path" box: the path in its storage (with a leading slash)
/// and the query, if any.
pub(crate) fn shown_address(url: &Url) -> String {
    let path = space_of(&decoded(url.path())).map(|(_, path, _)| path).unwrap_or_else(|_| decoded(url.path()));
    match url.query() {
        Some(query) if !query.is_empty() => format!("{path}?{}", decoded(query)),
        _ => path,
    }
}

/// Where the address's storage is, in words.
async fn describe_space(app: &AppHandle, url: &Url) -> String {
    match space_of(&decoded(url.path())).map(|(space, _, _)| space) {
        Ok(Space::Device(root)) => {
            let label = crate::picked_roots::label_of(app.state::<crate::secondary_windows::SecondaryWindowsState>().pool(), &root).await;
            label.map_or_else(|| "a folder of this device".to_string(), |l| format!("the folder \"{l}\""))
        }
        Ok(Space::Filen { user_id, branch }) => {
            let email = crate::filen::email_of(app, user_id).await.unwrap_or_else(|_| format!("account {user_id}"));
            match branch {
                Some(b) => format!("the Filen account {email} (branch {b})"),
                None => format!("the Filen account {email}"),
            }
        }
        _ => "the user folder".to_string(),
    }
}

/// A page asked its window to go to `target` (see the module documentation): asks the person and does what they choose.
pub(crate) async fn request(app: &AppHandle, window_guid: &str, target: Url) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    ask(app, window_guid, target).await;
    ASKING.store(false, Ordering::SeqCst);
}

const COPY_LABELS: [&str; 3] = ["To the clipboard", "To the app's clipboard", "Cancel"];

async fn ask(app: &AppHandle, window_guid: &str, target: Url) {
    let Some(current) = crate::window_host::current_page_url(app, window_guid) else { return };
    let url = match resolve(&current, &target) {
        Ok(url) => url,
        Err(reason) => {
            crate::window_host::choose(app, window_guid, "This link can't be followed", &reason, &["OK"]).await;
            return;
        }
    };
    let kind = classify(&url);
    let address = shown_address(&url);
    let mut message = format!("Type: {}\nPath: {address}\nIn: {}", kind.label(), describe_space(app, &url).await);

    // Every box has "Cancel" as its last button: a native box closed with its X or Esc answers as its last button does.
    let choice = if kind.opens_in_a_tab() {
        match crate::window_host::choose(app, window_guid, "What to do with this link?", &message, &["Open…", "Copy…", "Cancel"]).await {
            Some(0) => {
                match crate::window_host::choose(app, window_guid, "Open this link", &address, &["In this tab", "In a new tab", "Cancel"]).await {
                    Some(0) => return open(app, window_guid, &url, false).await,
                    Some(1) => return open(app, window_guid, &url, true).await,
                    _ => return,
                }
            }
            Some(1) => crate::window_host::choose(app, window_guid, "Copy the address", &address, &COPY_LABELS).await,
            _ => None,
        }
    } else {
        message.push_str("

This kind of link can't be opened in a window.");
        crate::window_host::choose(app, window_guid, "This link can't be opened here", &message, &COPY_LABELS).await
    };

    match choice {
        Some(0) => {
            if let Err(reason) = write_os_clipboard(app, &address).await {
                crate::window_host::choose(app, window_guid, "The address wasn't copied", &reason, &["OK"]).await;
            }
        }
        Some(1) => {
            let _ = app.state::<crate::internal_clipboard::InternalClipboard>().set(address);
        }
        _ => {}
    }
}

/// Puts `text` on the OS clipboard. Another program can be holding the clipboard for a moment (a clipboard manager looking
/// at what was just copied), so a refusal is tried again a few times before it is reported.
async fn write_os_clipboard(app: &AppHandle, text: &str) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..6 {
        match app.clipboard().write_text(text.to_string()) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(60 * (attempt + 1))).await;
    }
    Err(last)
}

/// Opens the link in the window's tab (or a new one) — and says so if that can't be done (the file isn't there…).
async fn open(app: &AppHandle, window_guid: &str, url: &Url, new_tab: bool) {
    let outcome = async {
        // A note is shown as its markdown.
        let page = if classify(url) == LinkKind::Note { note_page(app, url).await? } else { url.clone() };
        crate::secondary_windows::validate_relative_html_path(app, decoded(page.path()).trim_start_matches('/'))?;
        crate::secondary_windows::open_link_in_window(app, window_guid, &page, new_tab).await
    }
    .await;
    if let Err(reason) = outcome {
        crate::window_host::choose(app, window_guid, "The link wasn't opened", &reason, &["OK"]).await;
    }
}

/// The name of a note's markdown file among the entries of its short folder (`(name, is a folder)`): the file whose name ends
/// with `[note].md`.
pub(crate) fn note_markdown_among(entries: impl IntoIterator<Item = (String, bool)>) -> Option<String> {
    entries.into_iter().find(|(name, is_dir)| !is_dir && name.to_lowercase().ends_with("[note].md")).map(|(name, _)| name)
}

/// The page a note's address (`/Book/001?note`) stands for: its markdown file, found in the note's short folder — in the user
/// folder, a picked folder or a Filen account (branch). An error says why there is none.
async fn note_page(app: &AppHandle, note: &Url) -> Result<Url, String> {
    let (space, path, _) = space_of(&decoded(note.path()))?;
    let folder = path.trim_matches('/').to_string();
    let entries: Vec<(String, bool)> = match &space {
        Space::User | Space::Device(_) => {
            let root = if let Space::Device(root) = &space { root.as_str() } else { "user" };
            let real = app.state::<crate::fs_scope::FsScope>().check_in(root, &folder, true)?;
            std::fs::read_dir(&real)
                .map_err(|_| "That note's folder isn't there.".to_string())?
                .filter_map(Result::ok)
                .map(|entry| (entry.file_name().to_string_lossy().to_string(), entry.path().is_dir()))
                .collect()
        }
        Space::Filen { user_id, branch } => {
            let cache = app.state::<crate::files_cache::Cache>();
            let remote = crate::filen_cache::prepare(app, &cache, *user_id).await?;
            let listing = cache.list(&remote, *user_id as i64, *branch, &format!("/{folder}"), false).await?;
            listing.entries.into_iter().map(|e| (e.name, e.is_directory)).collect()
        }
    };
    let name = note_markdown_among(entries).ok_or("That note has no markdown file.")?;
    let mut page = note.clone();
    page.path_segments_mut().map_err(|_| "That address can't be opened.".to_string())?.pop_if_empty().push(&name);
    page.set_query(None);
    page.set_fragment(None);
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notes_markdown_is_the_file_ending_with_note_md() {
        let entries = vec![
            ("01".to_string(), true),
            ("[note-children].json".to_string(), false),
            ("0-Ideas[note].md".to_string(), false),
            ("[note].json".to_string(), false),
        ];
        assert_eq!(note_markdown_among(entries).as_deref(), Some("0-Ideas[note].md"));
        // A folder that happens to be called so is not a file; and a folder with no markdown has none.
        assert_eq!(note_markdown_among(vec![("x[note].md".to_string(), true)]), None);
        assert_eq!(note_markdown_among(vec![("[note].json".to_string(), false)]), None);
    }

    fn url(u: &str) -> Url {
        Url::parse(u).unwrap()
    }

    #[test]
    fn a_relative_link_stays_where_the_browser_put_it() {
        let current = url("http://csuser.localhost/qwer/index1.html");
        let resolved = resolve(&current, &url("http://csuser.localhost/qwer/index2.html?doc=3#top")).unwrap();
        assert_eq!(resolved.path(), "/qwer/index2.html");
        assert_eq!(resolved.query(), Some("doc=3"));
        assert_eq!(resolved.fragment(), None, "a fragment is not part of a page");
    }

    #[test]
    fn an_absolute_path_is_relative_to_the_root_of_the_pages_own_storage() {
        // The browser took "/docs/b.md" for a path of the user folder; the page is in a Filen account.
        let filen = url("http://csuser.localhost/@filen/123/-/notes/a.md");
        assert_eq!(resolve(&filen, &url("http://csuser.localhost/docs/b.md")).unwrap().path(), "/@filen/123/-/docs/b.md");
        let branch = url("http://csuser.localhost/@filen/123/4/notes/a.md");
        assert_eq!(resolve(&branch, &url("http://csuser.localhost/docs/b%20c.md?x=1")).unwrap().path(), "/@filen/123/4/docs/b%20c.md");
        let device = url("http://csuser.localhost/@device/ab12cd/x/a.md");
        assert_eq!(resolve(&device, &url("http://csuser.localhost/y.md")).unwrap().path(), "/@device/ab12cd/y.md");
        // A relative link in the same storage is untouched.
        assert_eq!(resolve(&filen, &url("http://csuser.localhost/@filen/123/-/notes/c.md")).unwrap().path(), "/@filen/123/-/notes/c.md");
        // In the user folder an absolute path is just a path.
        let user = url("http://csuser.localhost/qwer/index1.html");
        assert_eq!(resolve(&user, &url("http://csuser.localhost/other.html")).unwrap().path(), "/other.html");
    }

    #[test]
    fn a_link_cannot_lead_out_of_the_storage_its_page_is_in() {
        let filen = url("http://csuser.localhost/@filen/123/-/notes/a.md");
        assert!(resolve(&filen, &url("http://csuser.localhost/@filen/999/-/x.md")).is_err(), "another account");
        assert!(resolve(&filen, &url("http://csuser.localhost/@filen/123/4/x.md")).is_err(), "another branch");
        assert!(resolve(&filen, &url("http://csuser.localhost/@device/ab12cd/x.md")).is_err(), "a folder of the device");
        let user = url("http://csuser.localhost/qwer/index1.html");
        assert!(resolve(&user, &url("http://csuser.localhost/@filen/123/-/x.md")).is_err(), "from the user folder into an account");
        assert!(resolve(&user, &url("http://csuser.localhost/@nothing/x.md")).is_err(), "the reserved space, but not a storage");
    }

    #[test]
    fn what_a_link_names_is_told_from_its_path_and_query() {
        assert_eq!(classify(&url("http://csuser.localhost/a/b.md")), LinkKind::Markdown);
        assert_eq!(classify(&url("http://csuser.localhost/a/B.MARKDOWN")), LinkKind::Markdown);
        assert_eq!(classify(&url("http://csuser.localhost/a/b.html")), LinkKind::Html);
        assert_eq!(classify(&url("http://csuser.localhost/a/b.htm?x=1")), LinkKind::Html);
        assert_eq!(classify(&url("http://csuser.localhost/a/photo.png")), LinkKind::Other);
        assert_eq!(classify(&url("http://csuser.localhost/a/folder")), LinkKind::Other);
        // The key `note` makes it a note's address, whatever the path looks like.
        assert_eq!(classify(&url("http://csuser.localhost/Projects/01?note")), LinkKind::Note);
        assert_eq!(classify(&url("http://csuser.localhost/Projects/01?x=1&note=2")), LinkKind::Note);
        assert_eq!(classify(&url("http://csuser.localhost/Projects/01.md?notes=1")), LinkKind::Markdown, "another key");
    }

    #[test]
    fn the_address_shown_is_the_path_in_the_storage_with_its_query() {
        assert_eq!(shown_address(&url("http://csuser.localhost/@filen/123/-/docs/a%20b.md")), "/docs/a b.md");
        assert_eq!(shown_address(&url("http://csuser.localhost/@device/ab12cd/x/y.md?p=1")), "/x/y.md?p=1");
        assert_eq!(shown_address(&url("http://csuser.localhost/qwer/index1.html")), "/qwer/index1.html");
        assert_eq!(shown_address(&url("http://csuser.localhost/Projects/01?note")), "/Projects/01?note");
    }
}
