//! The **Folder Pairs Strategy** — how this app gives a thing (a cached Filen account, a branch, …)
//! a home on disk. The full write-up is `docs/strategies/folder-pairs-strategy.md`; this module is
//! the one implementation of it, so every place that needs a pair does it the same way.
//!
//! A thing gets **a pair of sibling folders** inside a parent folder:
//! - the **short folder**, `NNN` — its index, at least three digits, left-padded with zeros (`001`,
//!   `042`, `1000`). It holds the thing's actual data. Being short, it keeps deep paths inside the
//!   operating systems' length limits, whatever the human-readable name is.
//! - the **full folder**, `NNN-<full name part>` — the same index, a dash, then a human-readable
//!   description of what the pair is for. It stays empty: it exists so a person browsing the disk
//!   can tell which short folder is which.
//!
//! The index is **auto-incremented by looking at the disk**: list the parent's entries, take those
//! whose name starts with digits and a dash (only the *full* folders do), parse the digits, take the
//! largest and add one; with none, start at 1. So there's no counter to keep in sync — deleting a
//! pair is just deleting its two folders — and an index freed by deleting the newest pair is reused.
//!
//! Uses only `std`, so anything can call it.

use std::io;
use std::path::{Path, PathBuf};

/// Indexes are padded to at least this many digits.
const MIN_DIGITS: usize = 3;

/// The longest full-folder-name part we'll create (in characters): keeps the whole name well inside
/// the 255-byte limit of common file systems.
pub const MAX_NAME_PART_CHARS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPair {
    pub index: u32,
    /// `NNN`
    pub short_name: String,
    /// `NNN-<full name part>`
    pub full_name: String,
    pub short_dir: PathBuf,
    pub full_dir: PathBuf,
}

/// `NNN` for `index`.
pub fn short_name(index: u32) -> String {
    format!("{index:0width$}", width = MIN_DIGITS)
}

/// `NNN-<part>` for `index`.
pub fn full_name(index: u32, part: &str) -> String {
    format!("{}-{part}", short_name(index))
}

/// Splits a full folder name into its index and full name part — `None` if it doesn't start with
/// (at least three) digits and a dash. (A short folder, `NNN`, has no dash, so it never matches.)
pub fn parse_full_name(name: &str) -> Option<(u32, &str)> {
    let digits = name.bytes().take_while(u8::is_ascii_digit).count();
    if digits < MIN_DIGITS || name.as_bytes().get(digits) != Some(&b'-') {
        return None;
    }
    Some((name[..digits].parse().ok()?, &name[digits + 1..]))
}

fn make_pair(parent: &Path, index: u32, part: &str) -> FolderPair {
    let (short, full) = (short_name(index), full_name(index, part));
    FolderPair { index, short_dir: parent.join(&short), full_dir: parent.join(&full), short_name: short, full_name: full }
}

/// The index the next pair in `parent` gets: one more than the largest index among its full folders,
/// or 1 if there are none (or `parent` doesn't exist yet).
pub fn next_index(parent: &Path) -> io::Result<u32> {
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(1),
        Err(e) => return Err(e),
    };
    let mut largest = 0;
    for entry in entries {
        if let Some((index, _)) = parse_full_name(&entry?.file_name().to_string_lossy()) {
            largest = largest.max(index);
        }
    }
    Ok(largest + 1)
}

/// Creates a new pair for `part` in `parent` (creating `parent` if need be). The caller makes sure
/// there isn't one for `part` already (see `find`, `ensure`); callers that can race must serialise.
pub fn create(parent: &Path, part: &str) -> io::Result<FolderPair> {
    std::fs::create_dir_all(parent)?;
    let pair = make_pair(parent, next_index(parent)?, part);
    std::fs::create_dir(&pair.short_dir)?;
    std::fs::create_dir(&pair.full_dir)?;
    Ok(pair)
}

/// Every pair in `parent`, by index. (One is listed for each full folder, even if its short folder
/// has gone missing.)
pub fn list(parent: &Path) -> io::Result<Vec<(FolderPair, String)>> {
    let mut pairs = Vec::new();
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(pairs),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if let Some((index, part)) = parse_full_name(&name) {
            pairs.push((make_pair(parent, index, part), part.to_string()));
        }
    }
    pairs.sort_by_key(|(pair, _)| pair.index);
    Ok(pairs)
}

/// The pair whose full name part is exactly `part`, if `parent` has one.
pub fn find(parent: &Path, part: &str) -> io::Result<Option<FolderPair>> {
    Ok(list(parent)?.into_iter().find(|(_, p)| p == part).map(|(pair, _)| pair))
}

/// The pair for `part`, creating it (and repairing a missing short folder) if needed.
pub fn ensure(parent: &Path, part: &str) -> io::Result<FolderPair> {
    match find(parent, part)? {
        Some(pair) => {
            std::fs::create_dir_all(&pair.short_dir)?;
            Ok(pair)
        }
        None => create(parent, part),
    }
}

/// Deletes both folders of the pair for `part` (and everything in the short one). Returns whether
/// there was one.
pub fn delete(parent: &Path, part: &str) -> io::Result<bool> {
    let Some(pair) = find(parent, part)? else { return Ok(false) };
    for dir in [&pair.short_dir, &pair.full_dir] {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// Makes `text` safe to use as (part of) a folder name on every platform: characters that can't
/// appear in a Windows file name become `_`, and so do control characters; trailing dots and spaces
/// (which Windows drops) are removed; it's cut to `MAX_NAME_PART_CHARS`.
pub fn sanitize_part(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .take(MAX_NAME_PART_CHARS)
        .collect();
    cleaned.trim_end_matches(['.', ' ']).to_string()
}

/// Checks a name the user chose for a pair's full name part (a branch's name): non-empty, at most
/// `MAX_NAME_PART_CHARS` characters, and valid as a file name on every platform.
pub fn validate_part(name: &str) -> Result<(), String> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name.trim().is_empty() {
        return Err("Give it a name.".to_string());
    }
    if name.chars().count() > MAX_NAME_PART_CHARS {
        return Err(format!("The name can be at most {MAX_NAME_PART_CHARS} characters."));
    }
    if let Some(bad) = name.chars().find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
        return Err(format!("The name can't contain {}.", if bad.is_control() { "control characters".to_string() } else { format!("\"{bad}\"") }));
    }
    if name != name.trim() || name.ends_with('.') {
        return Err("The name can't start or end with a space, or end with a dot.".to_string());
    }
    if RESERVED.contains(&name.split('.').next().unwrap_or("").to_ascii_uppercase().as_str()) {
        return Err("That name is reserved by Windows.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csdrive-folder-pairs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn names_are_padded_and_parsed_back() {
        assert_eq!(short_name(1), "001");
        assert_eq!(short_name(42), "042");
        assert_eq!(short_name(1000), "1000");
        assert_eq!(full_name(7, "filen@@a@b.com@@12"), "007-filen@@a@b.com@@12");

        assert_eq!(parse_full_name("007-filen@@a@b.com@@12"), Some((7, "filen@@a@b.com@@12")));
        assert_eq!(parse_full_name("1000-big"), Some((1000, "big")));
        assert_eq!(parse_full_name("001-"), Some((1, "")));
        assert_eq!(parse_full_name("001"), None, "a short folder has no dash");
        assert_eq!(parse_full_name("12-x"), None, "fewer than three digits");
        assert_eq!(parse_full_name("abc-001"), None);
        assert_eq!(parse_full_name("001x-y"), None);
        assert_eq!(parse_full_name("-001"), None);
    }

    #[test]
    fn the_next_index_is_one_more_than_the_largest_seen_on_disk() {
        let parent = scratch("next");
        assert_eq!(next_index(&parent).unwrap(), 1, "a parent that doesn't exist yet");
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(next_index(&parent).unwrap(), 1, "an empty parent");

        for name in ["001", "001-a", "003-c", "notes.txt", "12-ignored", "002"] {
            std::fs::create_dir(parent.join(name)).unwrap();
        }
        assert_eq!(next_index(&parent).unwrap(), 4, "gaps aren't filled; short folders and others don't count");
        std::fs::remove_dir(parent.join("003-c")).unwrap();
        assert_eq!(next_index(&parent).unwrap(), 2, "an index freed by deleting the newest pair is reused");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_pair_is_created_found_repaired_and_deleted() {
        let parent = scratch("pair");
        let first = create(&parent, "filen@@a@x.com@@1").unwrap();
        let second = create(&parent, "filen@@b@x.com@@2").unwrap();
        assert_eq!((first.index, second.index), (1, 2));
        assert!(first.short_dir.is_dir() && first.full_dir.is_dir());
        assert_eq!(first.full_name, "001-filen@@a@x.com@@1");
        assert_eq!(std::fs::read_dir(&first.full_dir).unwrap().count(), 0, "the full folder stays empty");

        assert_eq!(find(&parent, "filen@@b@x.com@@2").unwrap(), Some(second.clone()));
        assert_eq!(find(&parent, "filen@@c@x.com@@3").unwrap(), None);
        assert_eq!(list(&parent).unwrap().len(), 2);

        // `ensure` reuses a pair and repairs a missing short folder.
        std::fs::remove_dir(&first.short_dir).unwrap();
        assert_eq!(ensure(&parent, "filen@@a@x.com@@1").unwrap(), first);
        assert!(first.short_dir.is_dir());
        assert_eq!(list(&parent).unwrap().len(), 2, "no duplicate");

        std::fs::write(second.short_dir.join("data.txt"), "x").unwrap();
        assert!(delete(&parent, "filen@@b@x.com@@2").unwrap());
        assert!(!second.short_dir.exists() && !second.full_dir.exists(), "both folders, and what was in them");
        assert!(!delete(&parent, "filen@@b@x.com@@2").unwrap(), "already gone");

        assert_eq!(create(&parent, "again").unwrap().index, 2, "the freed index is reused");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn names_are_sanitised_and_validated() {
        assert_eq!(sanitize_part("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_part("trailing. . "), "trailing");
        assert_eq!(sanitize_part(&"x".repeat(300)).chars().count(), MAX_NAME_PART_CHARS);
        assert_eq!(sanitize_part("ok@example.com"), "ok@example.com");

        assert!(validate_part("my branch").is_ok());
        assert!(validate_part("ținută 日本語").is_ok());
        assert!(validate_part(&"x".repeat(100)).is_ok());
        assert!(validate_part(&"x".repeat(101)).is_err(), "over 100 characters");
        for bad in ["", "   ", "a/b", "a:b", "what?", " lead", "trail ", "dot.", "CON", "nul.txt", "a\tb"] {
            assert!(validate_part(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
