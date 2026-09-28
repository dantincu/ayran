//! Rust-only diagnostic logging (`docs/features/features.md`'s "Dev Tools" idea): a plain-text file at
//! `admin/logs/csdrive.log` (`layout.rs`), a runtime-adjustable level, and a handful of commands for the
//! admin-app's own Dev Tools → Logs page (`get_log_level`/`set_log_level`, `get_log_file_info`,
//! `read_log_tail`, `export_log_file`) — the *page* only ever asks Rust for the current level, a file's
//! size/location, or its recent content; what gets logged, when and how is decided entirely by the Rust
//! code that calls `log::error!`/`warn!`/`info!`/`debug!`/`trace!` directly, never by anything a window asks
//! for. Every command here is admin-only.
//!
//! **What is logged, at which level** — the functions named actually call the macros; this module only
//! carries the bytes to disk:
//! - **Error / Warn** — refused prompts and prompt-guard bursts (`prompt_guard.rs`), a page's own dialog
//!   errors, Filen request failures (`filen::api`), local file-system refusals surfaced through the scope.
//! - **Info** — every **admin-only operation** (`window_host::require_admin`, the one choke point all of
//!   them already pass through — its own operation name, not the window) and every **notebook added or
//!   removed** (detected in `app_state::set_app_state` when the key is `notes.notebooks`, which is where
//!   Notes keeps its list — see CLAUDE.md's "Notebooks" — by diffing the old and new lists).
//! - **Debug** — every **Filen request** (`filen::api::send_json`/`download_chunk`/`upload_chunk`): one line
//!   each, the endpoint and the outcome.
//! - **Trace** — the same Filen requests again, but **before** sending too (not just after); every
//!   **local file-system request** (`fs_scope::FsScope::check_in`, the one choke point every `fs_*` command
//!   and SQLite path resolves through); every **tag added, changed, reordered or removed**
//!   (`secondary_windows.rs`); every **app-state or global-setting change** (`app_state.rs`, the same two
//!   choke points every settings page and every "remembered place" writes through).
//!
//! **Never logged: a file's contents, or the text of a search.** What *is* logged where it's genuinely
//! useful for finding a problem: file and folder names, relative paths, Filen item ids, setting/app-state
//! *keys* (never their values, which could be anything from a page position to a draft's own text) and tag
//! ids (never a tag's own text).
//!
//! **Where the file lives.** `admin/logs/csdrive.log` inside the data folder (Settings shows the real
//! folder; the Logs page shows this file's own path and size directly, since `admin/` is a protected path
//! no ordinary file command can reach — see `fs_scope.rs`). On Windows that is ordinarily
//! `%APPDATA%\com.ayran.csdrive-webhost-tauriapp\admin\logs\csdrive.log`; on Android, inside the app's
//! private storage at the same relative place, `.../files/admin/logs/csdrive.log` (or wherever a relocated
//! data folder points, on either platform — the log file travels with it like everything else in `admin/`).
//! Past `MAX_LOG_BYTES` the file is rotated: renamed to `csdrive.log.old` (replacing any earlier one) and a
//! fresh one started, so a `Trace` session left running can't grow the file without bound while still
//! keeping the last full rotation's worth of detail around.
//!
//! **A plain, synchronous file write, not a background writer.** `Log::log` opens the file, appends one
//! line and closes it again, every time, under one `Mutex` that also guards rotation — the simplest thing
//! that can't tear a line across two files or two threads' writes across each other, and cheap enough for a
//! diagnostic logger's actual call volume (this is not a hot path meant to log on every keystroke). Blocking
//! the odd async task for the few microseconds a tiny append takes is an accepted trade against the
//! complexity of a channel and a dedicated writer thread.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

use log::{LevelFilter, Log, Metadata, Record};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// Once the file would exceed this size the next line rotates it first (see the module doc).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub const DEFAULT_LEVEL: LogLevel = LogLevel::Info;

/// `global_settings`' key the level is persisted under — refused by the generic `set_global_setting`, the
/// same way `appearance.` keys are (`app_state::set_global_setting`); only `set_log_level` (admin-only,
/// below) may change it.
pub const LEVEL_SETTING_KEY: &str = "dev.logLevel";
pub const RESERVED_PREFIX: &str = "dev.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Off,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => LogLevel::Off,
            1 => LogLevel::Error,
            2 => LogLevel::Warn,
            3 => LogLevel::Info,
            4 => LogLevel::Debug,
            _ => LogLevel::Trace,
        }
    }
    fn as_u8(self) -> u8 {
        match self {
            LogLevel::Off => 0,
            LogLevel::Error => 1,
            LogLevel::Warn => 2,
            LogLevel::Info => 3,
            LogLevel::Debug => 4,
            LogLevel::Trace => 5,
        }
    }
    fn to_filter(self) -> LevelFilter {
        match self {
            LogLevel::Off => LevelFilter::Off,
            LogLevel::Error => LevelFilter::Error,
            LogLevel::Warn => LevelFilter::Warn,
            LogLevel::Info => LevelFilter::Info,
            LogLevel::Debug => LevelFilter::Debug,
            LogLevel::Trace => LevelFilter::Trace,
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "off" => LogLevel::Off,
            "error" => LogLevel::Error,
            "warn" => LogLevel::Warn,
            "info" => LogLevel::Info,
            "debug" => LogLevel::Debug,
            "trace" => LogLevel::Trace,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Off => "off",
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }
}

struct FileLogger {
    path: PathBuf,
    old_path: PathBuf,
    write_lock: Mutex<u64>, // the current file's own size, guarding writes and rotation together
    level: AtomicU8,
}

impl FileLogger {
    fn new(path: PathBuf, level: LogLevel) -> Self {
        let old_path = {
            let mut p = path.clone();
            let name = format!("{}.old", path.file_name().and_then(|n| n.to_str()).unwrap_or("csdrive.log"));
            p.set_file_name(name);
            p
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path, old_path, write_lock: Mutex::new(size), level: AtomicU8::new(level.as_u8()) }
    }

    fn level(&self) -> LogLevel {
        LogLevel::from_u8(self.level.load(Ordering::Relaxed))
    }

    fn set_level(&self, level: LogLevel) {
        self.level.store(level.as_u8(), Ordering::Relaxed);
    }
}

/// `log::set_logger` makes this the process's *only* logger — every crate that logs through the `log` facade
/// (not just this app's own code) reaches it, `sqlx`'s own per-query debug logging very much included (found
/// live: turning the level up filled the file with `sqlx::query`'s own lines, SQL text and all — noise this
/// module never asked for, and outside everything CLAUDE.md's own level table promises). Only a record whose
/// `target` is this crate's own module path (every `log::info!`/etc. call site's default target) is ever
/// written; anything else, at any level, is dropped before it's even formatted.
const OUR_TARGET_PREFIX: &str = "csdrive_webhost_tauriapp_lib";

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.target().starts_with(OUR_TARGET_PREFIX) && metadata.level() <= self.level().to_filter()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:5} {} - {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );
        let Ok(mut size) = self.write_lock.lock() else { return };
        // Rotate *before* appending this line — never mid-line, and never after (a line that would push it
        // over the limit still belongs in the file that was current when it was logged).
        if *size > 0 && *size + line.len() as u64 > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(&self.old_path);
            if std::fs::rename(&self.path, &self.old_path).is_ok() {
                *size = 0;
            }
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path) {
            if file.write_all(line.as_bytes()).is_ok() {
                *size += line.len() as u64;
            }
        }
    }

    fn flush(&self) {}
}

static LOGGER: OnceLock<&'static FileLogger> = OnceLock::new();

fn logger() -> &'static FileLogger {
    LOGGER.get().expect("logging::init was not called")
}

/// Creates `admin/logs` (if it doesn't exist yet) and installs the logger, at `DEFAULT_LEVEL` — before
/// `data.db` is open, so nothing this early can yet know a persisted level. Call `apply_persisted_level`
/// once it is, to pick up what Settings/Dev Tools last chose. Safe to call only once (`lib.rs`'s `.setup()`).
pub fn init(data_dir: &Path) -> Result<(), String> {
    let path = crate::layout::log_file_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let logger: &'static FileLogger = Box::leak(Box::new(FileLogger::new(path, DEFAULT_LEVEL)));
    LOGGER.set(logger).map_err(|_| "logging::init was called twice".to_string())?;
    log::set_logger(logger).map_err(|e| e.to_string())?;
    // The *real* filtering is FileLogger::enabled's own runtime-adjustable atomic; the crate-wide max stays
    // at Trace always, so raising the level later (set_log_level) needs no re-registration.
    log::set_max_level(LevelFilter::Trace);
    Ok(())
}

/// Reads the level Settings/Dev Tools last chose (`global_settings`) and applies it — once `data.db` is open.
pub async fn apply_persisted_level(pool: &SqlitePool) {
    let saved: Option<String> = sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1")
        .bind(LEVEL_SETTING_KEY)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if let Some(level) = saved.as_deref().and_then(LogLevel::from_str) {
        logger().set_level(level);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    /// Shown to the person directly (admin-only, like `get_data_folder_info`'s own real paths).
    pub path: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn get_log_level(window: crate::window_host::CallerWindow) -> Result<String, String> {
    crate::window_host::require_admin(&window, "get_log_level")?;
    Ok(logger().level().as_str().to_string())
}

#[tauri::command]
pub async fn set_log_level(window: crate::window_host::CallerWindow, state: tauri::State<'_, crate::app_state::AppDbState>, level: String) -> Result<(), String> {
    crate::window_host::require_admin(&window, "set_log_level")?;
    let parsed = LogLevel::from_str(&level).ok_or_else(|| format!("\"{level}\" isn't a log level."))?;
    sqlx::query("INSERT INTO global_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(LEVEL_SETTING_KEY)
        .bind(parsed.as_str())
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    logger().set_level(parsed);
    log::info!("log level changed to {}", parsed.as_str());
    Ok(())
}

#[tauri::command]
pub fn get_log_file_info(window: crate::window_host::CallerWindow) -> Result<LogFileInfo, String> {
    crate::window_host::require_admin(&window, "get_log_file_info")?;
    let l = logger();
    let size_bytes = std::fs::metadata(&l.path).map(|m| m.len()).unwrap_or(0);
    Ok(LogFileInfo { path: l.path.display().to_string(), size_bytes })
}

/// The end of the current log file — at most `max_bytes` (capped; default 200 KiB) — for the Logs page to
/// show without loading a huge file into the page. Reads off the async runtime's own threads.
#[tauri::command]
pub async fn read_log_tail(window: crate::window_host::CallerWindow, max_bytes: Option<u64>) -> Result<String, String> {
    crate::window_host::require_admin(&window, "read_log_tail")?;
    let cap = max_bytes.unwrap_or(200_000).min(2_000_000) as usize;
    let path = logger().path.clone();
    crate::fs_commands::blocking(move || {
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        let start = data.len().saturating_sub(cap);
        Ok(String::from_utf8_lossy(&data[start..]).into_owned())
    })
    .await
}

/// Exports the *current* log file to the device, the same two-step flow (`choose_save_location` on desktop,
/// a native confirmation on Android) every other export uses — see `device_files.rs`. Not asked to confirm
/// itself (`confirm_export`): this is the admin-app's own button, not a page's doing.
#[tauri::command]
pub async fn export_log_file(
    window: crate::window_host::CallerWindow,
    export_state: tauri::State<'_, crate::device_files::ExportState>,
    token: Option<String>,
) -> Result<String, String> {
    crate::window_host::require_admin(&window, "export_log_file")?;
    let source = logger().path.clone();
    crate::device_files::export_file(export_state.inner(), crate::layout::LOG_FILE.to_string(), token, source).await
}

/// `notes.notebooks`' old and new lists, from `app_state::set_app_state` (only that one key is inspected —
/// see the module doc), diffed by `guid` and logged at `Info`: `title`, never anything else about the
/// notebook (its folder is a relative path already shown elsewhere; nothing here is new exposure).
pub fn log_notebooks_changed(old_value: Option<&str>, new_value: &str) {
    #[derive(Deserialize)]
    struct Entry {
        guid: String,
        title: String,
    }
    fn parse(s: &str) -> Vec<Entry> {
        serde_json::from_str(s).unwrap_or_default()
    }
    let old = old_value.map(parse).unwrap_or_default();
    let new = parse(new_value);
    for entry in &new {
        if !old.iter().any(|o| o.guid == entry.guid) {
            log::info!("notebook added: {}", entry.title);
        }
    }
    for entry in &old {
        if !new.iter().any(|n| n.guid == entry.guid) {
            log::info!("notebook removed: {}", entry.title);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Level;

    #[test]
    fn every_level_round_trips_through_its_string() {
        for level in [LogLevel::Off, LogLevel::Error, LogLevel::Warn, LogLevel::Info, LogLevel::Debug, LogLevel::Trace] {
            assert_eq!(LogLevel::from_str(level.as_str()), Some(level));
        }
        assert_eq!(LogLevel::from_str("nonsense"), None);
    }

    /// A target of our own crate — the only kind `FileLogger` ever writes (see `OUR_TARGET_PREFIX`'s own doc).
    const OUR_TEST_TARGET: &str = "csdrive_webhost_tauriapp_lib::some_module";

    #[test]
    fn a_file_logger_only_writes_what_its_own_level_allows() {
        let dir = std::env::temp_dir().join(format!("csdrive-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let logger = FileLogger::new(path.clone(), LogLevel::Warn);
        let meta_info = Metadata::builder().level(Level::Info).target(OUR_TEST_TARGET).build();
        let meta_error = Metadata::builder().level(Level::Error).target(OUR_TEST_TARGET).build();
        assert!(!logger.enabled(&meta_info), "Info is quieter than the Warn level set");
        assert!(logger.enabled(&meta_error));
        logger.log(&Record::builder().level(Level::Info).target(OUR_TEST_TARGET).args(format_args!("hidden")).build());
        logger.log(&Record::builder().level(Level::Error).target(OUR_TEST_TARGET).args(format_args!("shown")).build());
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("hidden"), "{written}");
        assert!(written.contains("shown") && written.contains("ERROR"), "{written}");
        logger.set_level(LogLevel::Trace);
        assert!(logger.enabled(&meta_info));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_third_party_crates_own_logging_never_reaches_the_file() {
        let dir = std::env::temp_dir().join(format!("csdrive-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let logger = FileLogger::new(path.clone(), LogLevel::Trace);
        let sqlx_meta = Metadata::builder().level(Level::Error).target("sqlx::query").build();
        assert!(!logger.enabled(&sqlx_meta), "not our own crate's target, whatever the level");
        logger.log(&Record::builder().level(Level::Error).target("sqlx::query").args(format_args!("SELECT ...")).build());
        assert!(!path.exists(), "nothing was ever written, so the file was never even created");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_past_the_size_limit_rotates_instead_of_growing_without_bound() {
        let dir = std::env::temp_dir().join(format!("csdrive-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES - 10) as usize]).unwrap();
        let logger = FileLogger::new(path.clone(), LogLevel::Trace);
        logger.log(&Record::builder().level(Level::Info).target(OUR_TEST_TARGET).args(format_args!("this line tips it over the edge")).build());
        assert!(path.exists(), "a fresh current file exists");
        assert!(logger.old_path.exists(), "the old, oversized file was kept as .old");
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(fresh.contains("this line tips it over the edge"), "{fresh}");
        assert!(fresh.len() < 1000, "the new file starts fresh, not from the old size: {} bytes", fresh.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn notebook_add_and_remove_are_each_detected_from_the_diff() {
        // Can't assert on the log output itself without a test logger installed (the real one is a
        // process-global singleton) — this at least exercises the parsing/diff logic for a panic.
        let old = r#"[{"guid":"a","title":"Keep"},{"guid":"b","title":"Gone"}]"#;
        let new = r#"[{"guid":"a","title":"Keep"},{"guid":"c","title":"New"}]"#;
        log_notebooks_changed(Some(old), new);
        log_notebooks_changed(None, new);
    }
}
