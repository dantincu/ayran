//! The **Folder Pairs Strategy** — how this app gives a thing (a cached Filen account, a branch, …)
//! a home on disk. The full write-up is `docs/strategies/folder-pairs-strategy.md`; this module is
//! the one implementation of it, so every place that needs a pair does it the same way.
//!
//! A thing gets **a pair of sibling folders** inside a parent folder:
//! - the **short folder**, `NNN` — its index, at least three digits, left-padded with zeros (`001`,
//!   `042`, `1000`). It holds the thing's actual data. Being short, it keeps deep paths inside the
//!   operating systems' length limits, whatever the human-readable name is.
//! - the **full folder**, `NNN-<full name part>` — the same index, a dash, then a human-readable
//!   description of what the pair is for. It holds nothing but a `.keep` file (see [`KEEP_FILE`]): it
//!   exists so a person browsing the disk can tell which short folder is which.
//!
//! The index is **worked out by looking at the disk**: list the parent's entries, take those whose
//! name starts with digits and a dash (only the *full* folders do), and parse the digits. Then, by the
//! caller's choice (`Indexing`), the new pair gets either one more than the largest of them
//! (`AfterLargest`, or 1 if there are none) or the lowest index nobody uses (`FillGaps`). Either
//! way there's no counter to keep in sync — deleting a pair is just deleting its two folders.
//!
//! Uses only `std`, so anything can call it.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

/// Indexes are padded to at least this many digits.
const MIN_DIGITS: usize = 3;

/// The file every full folder holds, so that it is never an *empty* folder: copying or mirroring folders to and from
/// cloud storage, and archiving them, tend to lose empty folders — and the pair must stay side by side wherever it goes.
pub const KEEP_FILE: &str = ".keep";

/// What `KEEP_FILE` holds: one dash — not nothing, because some cloud storage systems ignore empty files too.
pub const KEEP_CONTENT: &str = "-";

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

/// How a new pair's index is chosen among the indexes already in use in the parent folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Indexing {
    /// One more than the largest index in use (1 if none): `001` and `003` are followed by `004`. An
    /// index freed by deleting the *newest* pair comes back, but gaps further down are left alone.
    #[allow(dead_code)] // the strategy's other policy: nothing in the app uses it now (everything fills gaps), the tests do
    AfterLargest,
    /// The lowest index (from 1) that isn't in use: `001` and `003` are followed by `002`, then `004`.
    /// Deleted pairs' indexes are all reused, so the numbers stay as small as they can be. (A bare
    /// short folder `NNN` with no full folder beside it counts as in use, so the new pair's short
    /// folder can never collide with it.)
    FillGaps,
}

/// The indexes in use in `parent`: those of its full folders — and, when `count_short_folders`, also
/// of any folder that is just `NNN` (a pair whose full folder went missing).
fn indexes_in_use(parent: &Path, count_short_folders: bool) -> io::Result<BTreeSet<u32>> {
    let mut used = BTreeSet::new();
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(used),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if let Some((index, _)) = parse_full_name(&name) {
            used.insert(index);
        } else if count_short_folders && name.len() >= MIN_DIGITS && name.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(index) = name.parse() {
                used.insert(index);
            }
        }
    }
    Ok(used)
}

/// The index the next pair in `parent` gets, per `indexing` — 1 if `parent` has no pairs (or doesn't
/// exist yet).
pub fn next_index(parent: &Path, indexing: Indexing) -> io::Result<u32> {
    let used = indexes_in_use(parent, indexing == Indexing::FillGaps)?;
    Ok(match indexing {
        Indexing::AfterLargest => used.last().map_or(1, |largest| largest + 1),
        Indexing::FillGaps => (1..).find(|index| !used.contains(index)).expect("fewer than u32::MAX pairs"),
    })
}

/// Makes sure `full_dir` (which is made if it is missing) holds its `KEEP_FILE`, with the right content. Returns whether
/// it had to write it.
fn mark_full_dir(full_dir: &Path) -> io::Result<bool> {
    std::fs::create_dir_all(full_dir)?;
    let keep = full_dir.join(KEEP_FILE);
    if std::fs::read(&keep).is_ok_and(|content| content == KEEP_CONTENT.as_bytes()) {
        return Ok(false);
    }
    std::fs::write(&keep, KEEP_CONTENT)?;
    Ok(true)
}

/// Gives every pair in `parent` its `KEEP_FILE` if it lacks one — the pairs made before the rule existed, or whose marker was
/// lost on the way somewhere. Returns how many it wrote. (`ensure` does the same for the one pair it is asked about.)
pub fn repair(parent: &Path) -> io::Result<usize> {
    let mut written = 0;
    for (pair, _) in list(parent)? {
        if mark_full_dir(&pair.full_dir)? {
            written += 1;
        }
    }
    Ok(written)
}

/// Creates a new pair for `part` in `parent` (creating `parent` if need be), its index chosen per
/// `indexing`. The caller makes sure there isn't one for `part` already (see `find`, `ensure`);
/// callers that can race must serialise.
pub fn create(parent: &Path, part: &str, indexing: Indexing) -> io::Result<FolderPair> {
    std::fs::create_dir_all(parent)?;
    let pair = make_pair(parent, next_index(parent, indexing)?, part);
    std::fs::create_dir(&pair.short_dir)?;
    std::fs::create_dir(&pair.full_dir)?;
    mark_full_dir(&pair.full_dir)?;
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

/// The pair for `part`, creating it (with `indexing`) or repairing a missing short folder or `KEEP_FILE` if needed.
pub fn ensure(parent: &Path, part: &str, indexing: Indexing) -> io::Result<FolderPair> {
    match find(parent, part)? {
        Some(pair) => {
            std::fs::create_dir_all(&pair.short_dir)?;
            mark_full_dir(&pair.full_dir)?;
            Ok(pair)
        }
        None => create(parent, part, indexing),
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
        let after = Indexing::AfterLargest;
        assert_eq!(next_index(&parent, after).unwrap(), 1, "a parent that doesn't exist yet");
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(next_index(&parent, after).unwrap(), 1, "an empty parent");

        for name in ["001", "001-a", "003-c", "notes.txt", "12-ignored", "002"] {
            std::fs::create_dir(parent.join(name)).unwrap();
        }
        assert_eq!(next_index(&parent, after).unwrap(), 4, "gaps aren't filled; short folders and others don't count");
        std::fs::remove_dir(parent.join("003-c")).unwrap();
        assert_eq!(next_index(&parent, after).unwrap(), 2, "an index freed by deleting the newest pair is reused");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn filling_gaps_takes_the_lowest_index_nobody_uses() {
        let parent = scratch("gaps");
        let fill = Indexing::FillGaps;
        assert_eq!(next_index(&parent, fill).unwrap(), 1, "a parent that doesn't exist yet");
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(next_index(&parent, fill).unwrap(), 1, "an empty parent");

        for name in ["001-a", "003-c", "notes.txt", "12-ignored"] {
            std::fs::create_dir(parent.join(name)).unwrap();
        }
        assert_eq!(next_index(&parent, fill).unwrap(), 2, "the gap between 001 and 003");
        std::fs::create_dir(parent.join("002-b")).unwrap();
        assert_eq!(next_index(&parent, fill).unwrap(), 4, "no gap left: one more than the largest");
        std::fs::remove_dir(parent.join("001-a")).unwrap();
        assert_eq!(next_index(&parent, fill).unwrap(), 1, "a gap at the very start");

        // A bare short folder (its full folder is gone) still holds its index.
        std::fs::create_dir(parent.join("001")).unwrap();
        assert_eq!(next_index(&parent, fill).unwrap(), 4);
        assert_eq!(next_index(&parent, Indexing::AfterLargest).unwrap(), 4, "and the other policy agrees here");
        std::fs::remove_dir(parent.join("002-b")).unwrap();
        assert_eq!(next_index(&parent, fill).unwrap(), 2);
        assert_eq!(next_index(&parent, Indexing::AfterLargest).unwrap(), 4, "which ignores gaps, as before");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_pair_is_created_found_repaired_and_deleted() {
        let parent = scratch("pair");
        let after = Indexing::AfterLargest;
        let first = create(&parent, "filen@@a@x.com@@1", after).unwrap();
        let second = create(&parent, "filen@@b@x.com@@2", after).unwrap();
        assert_eq!((first.index, second.index), (1, 2));
        assert!(first.short_dir.is_dir() && first.full_dir.is_dir());
        assert_eq!(first.full_name, "001-filen@@a@x.com@@1");
        let held: Vec<_> = std::fs::read_dir(&first.full_dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(held, [KEEP_FILE], "the full folder holds only its .keep");
        assert_eq!(std::fs::read_to_string(first.full_dir.join(KEEP_FILE)).unwrap(), "-", "with one dash in it");

        assert_eq!(find(&parent, "filen@@b@x.com@@2").unwrap(), Some(second.clone()));
        assert_eq!(find(&parent, "filen@@c@x.com@@3").unwrap(), None);
        assert_eq!(list(&parent).unwrap().len(), 2);

        // `ensure` reuses a pair and repairs a missing short folder.
        std::fs::remove_dir(&first.short_dir).unwrap();
        assert_eq!(ensure(&parent, "filen@@a@x.com@@1", after).unwrap(), first);
        assert!(first.short_dir.is_dir());
        assert_eq!(list(&parent).unwrap().len(), 2, "no duplicate");

        std::fs::write(second.short_dir.join("data.txt"), "x").unwrap();
        assert!(delete(&parent, "filen@@b@x.com@@2").unwrap());
        assert!(!second.short_dir.exists() && !second.full_dir.exists(), "both folders, and what was in them");
        assert!(!delete(&parent, "filen@@b@x.com@@2").unwrap(), "already gone");

        assert_eq!(create(&parent, "again", after).unwrap().index, 2, "the freed index is reused");

        // Filling gaps: 001 and 003 exist, so the new pair is 002 — created, whole, in the gap.
        let third = create(&parent, "third", after).unwrap();
        assert_eq!(third.index, 3);
        assert!(delete(&parent, "again").unwrap());
        let filled = create(&parent, "filled", Indexing::FillGaps).unwrap();
        assert_eq!((filled.index, filled.short_name.as_str()), (2, "002"));
        assert!(filled.short_dir.is_dir() && filled.full_dir.is_dir());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_full_folder_made_before_the_rule_gets_its_keep_file_and_a_lost_one_comes_back() {
        let parent = scratch("keep");
        // Two pairs as older versions made them: the full folder empty.
        for name in ["001", "001-old@@a", "002", "002-old@@b"] {
            std::fs::create_dir_all(parent.join(name)).unwrap();
        }
        std::fs::write(parent.join("002").join("data.txt"), "data").unwrap();
        assert_eq!(repair(&parent).unwrap(), 2, "both got one");
        for full in ["001-old@@a", "002-old@@b"] {
            assert_eq!(std::fs::read_to_string(parent.join(full).join(KEEP_FILE)).unwrap(), "-", "{full}");
        }
        assert!(!parent.join("001").join(KEEP_FILE).exists() && !parent.join("002").join(KEEP_FILE).exists(), "the short folders are the data's and stay as they are");
        assert_eq!(std::fs::read_to_string(parent.join("002").join("data.txt")).unwrap(), "data");
        assert_eq!(repair(&parent).unwrap(), 0, "nothing more to do");
        assert_eq!(repair(&parent.join("nowhere")).unwrap(), 0, "a parent that isn't there has no pairs");

        // A marker with the wrong content, or one that got lost, is put right — by `repair` and by `ensure`.
        std::fs::write(parent.join("001-old@@a").join(KEEP_FILE), "").unwrap();
        std::fs::remove_file(parent.join("002-old@@b").join(KEEP_FILE)).unwrap();
        assert_eq!(repair(&parent).unwrap(), 2);
        std::fs::remove_file(parent.join("002-old@@b").join(KEEP_FILE)).unwrap();
        ensure(&parent, "old@@b", Indexing::FillGaps).unwrap();
        assert_eq!(std::fs::read_to_string(parent.join("002-old@@b").join(KEEP_FILE)).unwrap(), "-");
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
