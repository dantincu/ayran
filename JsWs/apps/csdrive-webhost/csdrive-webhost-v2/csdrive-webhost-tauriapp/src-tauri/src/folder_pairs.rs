//! The **Folder Pairs Strategy** — how this app gives a thing (a cached Filen account, a branch, a note…)
//! a home on disk. The full write-up is `docs/strategies/folder-pairs-strategy.md`; this module is
//! the one implementation of it, so every place that needs a pair does it the same way.
//!
//! A thing gets **a pair of sibling folders** inside a parent folder:
//! - the **short folder**, `<prefix>NNN` — the index, at least as many digits as the numbering says (three by
//!   default), left-padded with zeros (`001`, `042`, `1000`), after an optional constant prefix. It holds the
//!   thing's actual data. Being short, it keeps deep paths inside the operating systems' length limits, whatever
//!   the human-readable name is.
//! - the **full folder**, `<prefix>NNN-<full name part>` — the same, a dash, then a human-readable description of
//!   what the pair is for. It holds nothing but a `.keep` file (see `keepFile` (in the config)): it exists so a person browsing
//!   the disk can tell which short folder is which.
//!
//! **How names and indexes are chosen is a [`Numbering`]**: a prefix, an [`Interval`] of indexes (ascending or
//! descending, from one end to the other, with a number of digits) and, by the caller's choice ([`Indexing`]), whether
//! a new pair takes the *first free* index of the interval or the one *after the largest in use*. An interval with a
//! single index is a constant. Several numberings can share one parent folder, each owning the indexes of its own
//! interval. Nothing is remembered: the index is **worked out by looking at the disk** each time, so deleting a
//! pair is just deleting its two folders.
//!
//! Uses only `std`, so anything can call it.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

/// The file every full folder holds, so that it is never an *empty* folder: copying or mirroring folders to and from
/// cloud storage, and archiving them, tend to lose empty folders — and the pair must stay side by side wherever it goes.
pub fn keep_file() -> &'static str {
    &crate::config::get().folder_pairs.keep_file
}

/// What `keepFile` holds: one dash — not nothing, because some cloud storage systems ignore empty files too.
pub fn keep_content() -> &'static str {
    &crate::config::get().folder_pairs.keep_content
}

/// The prefix pairs carry *while* many of them are being renumbered (see [`reassign`]): every pair is first renamed to
/// it, and only then to its final name, so that no new name can collide with a name that has not moved yet.
#[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
pub fn temporary_prefix() -> &'static str {
    &crate::config::get().folder_pairs.temporary_prefix
}

/// The longest full-folder-name part we'll create (in characters): keeps the whole name well inside
/// the 255-byte limit of common file systems.
pub fn max_name_part_chars() -> usize {
    crate::config::get().folder_pairs.max_name_part_chars
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPair {
    pub index: u32,
    /// `<prefix>NNN`
    pub short_name: String,
    /// `<prefix>NNN-<full name part>`
    pub full_name: String,
    /// The full name part.
    pub part: String,
    pub short_dir: PathBuf,
    pub full_dir: PathBuf,
}

/// The indexes a numbering may hand out: from `from` to `to`, both included — going up when `from` is the smaller
/// (`1`–`999`), down when it is the larger (`999`–`401`) — written with at least `digits` digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interval {
    pub from: u32,
    pub to: u32,
    pub digits: usize,
}

impl Interval {
    pub const fn ascending(from: u32, to: u32, digits: usize) -> Self {
        assert!(from <= to, "an ascending interval goes from the smaller to the larger");
        Self { from, to, digits }
    }

    #[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
    pub const fn descending(from: u32, to: u32, digits: usize) -> Self {
        assert!(from >= to, "a descending interval goes from the larger to the smaller");
        Self { from, to, digits }
    }

    /// An interval of one index: a pair that has a fixed number rather than a computed one.
    #[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
    pub const fn fixed(index: u32, digits: usize) -> Self {
        Self { from: index, to: index, digits }
    }

    pub const fn contains(&self, index: u32) -> bool {
        let (low, high) = if self.from <= self.to { (self.from, self.to) } else { (self.to, self.from) };
        low <= index && index <= high
    }

    const fn descends(&self) -> bool {
        self.from > self.to
    }
}

/// How a new pair's index is chosen among the indexes already in use in the parent folder (inside the numbering's
/// interval — the others belong to other numberings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Indexing {
    /// The interval's first index nobody uses, walking from its start: with `001` and `003` in use, `002`, then `004`.
    /// Deleted pairs' indexes are all reused, so the numbers stay as close to the start as they can be. (A bare short
    /// folder with no full folder beside it counts as in use, so the new pair's short folder can never collide with it.)
    FillGaps,
    /// One step past the furthest index in use, in the interval's direction (the start if none): `001` and `003` are
    /// followed by `004`; `999` and `997` in a descending interval by `996`. An index freed by deleting the *newest*
    /// pair comes back, but gaps further back are left alone — the order of creation is the order of the numbers.
    #[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
    AfterLargest,
}

/// Names and index choice for pairs: a constant `prefix` (usually empty), an [`Interval`] and an [`Indexing`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Numbering {
    /// Prepended to both folders' names. Must not begin with a digit (it would blur where the index starts).
    pub prefix: &'static str,
    pub interval: Interval,
    pub indexing: Indexing,
}

impl Numbering {
    /// What the app's own pairs (cached accounts, branches) use: no prefix, from `001` upward without an end, three digits
    /// (more above 999), filling gaps.
    /// What the shipped config says the app's own pairs use (`config::DEFAULT_NUMBERING`) — kept as a constant for the tests.
    #[cfg(test)]
    pub const DEFAULT: Numbering = Numbering { prefix: "", interval: Interval::ascending(1, u32::MAX, 3), indexing: Indexing::FillGaps };

    #[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
    pub const fn new(prefix: &'static str, interval: Interval, indexing: Indexing) -> Self {
        Self { prefix, interval, indexing }
    }

    /// The same numbering under `TEMPORARY_PREFIX` (in the config).
    #[allow(dead_code)] // the notes do their renumbering in the frontend (noteModel.ts), with the same prefix from the same config
    pub fn temporary(&self) -> Self {
        Self { prefix: temporary_prefix(), ..*self }
    }

    /// `<prefix>NNN` for `index`.
    pub fn short_name(&self, index: u32) -> String {
        format!("{}{}", self.prefix, self.digits_of(index))
    }

    /// `<prefix>NNN-<part>` for `index`.
    pub fn full_name(&self, index: u32, part: &str) -> String {
        format!("{}-{part}", self.short_name(index))
    }

    /// The digits of `index` as this numbering writes them: padded with zeros to the interval's width, longer if the number is.
    fn digits_of(&self, index: u32) -> String {
        format!("{index:0width$}", width = self.interval.digits)
    }

    /// Splits a full folder name into its index and full name part — `None` if it doesn't have this numbering's prefix,
    /// then the index written *the way this numbering writes it* (padded to the interval's width, no extra zeros: `001`
    /// is not a two-digit numbering's `01`), then a dash. (A short folder has no dash, so it never matches.) Whether the
    /// index is one of this numbering's *interval* is a separate question (`Interval::contains`): a name can be
    /// well-formed for a numbering and still be another one's pair.
    pub fn parse<'a>(&self, name: &'a str) -> Option<(u32, &'a str)> {
        let rest = name.strip_prefix(self.prefix)?;
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits < self.interval.digits || rest.as_bytes().get(digits) != Some(&b'-') {
            return None;
        }
        let index: u32 = rest[..digits].parse().ok()?;
        (rest[..digits] == self.digits_of(index)).then(|| (index, &rest[digits + 1..]))
    }

    /// The index of a bare short folder (`<prefix>NNN`, nothing after the digits).
    fn parse_short(&self, name: &str) -> Option<u32> {
        let rest = name.strip_prefix(self.prefix)?;
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let index: u32 = rest.parse().ok()?;
        (rest == self.digits_of(index)).then_some(index)
    }

    fn make_pair(&self, parent: &Path, index: u32, part: &str) -> FolderPair {
        let (short, full) = (self.short_name(index), self.full_name(index, part));
        FolderPair { index, part: part.to_string(), short_dir: parent.join(&short), full_dir: parent.join(&full), short_name: short, full_name: full }
    }

    fn check_prefix(&self) -> io::Result<()> {
        let bad = |why: &str| Err(io::Error::new(io::ErrorKind::InvalidInput, format!("The prefix \"{}\" {why}.", self.prefix)));
        if self.prefix.is_empty() {
            return Ok(());
        }
        if self.prefix.starts_with(|c: char| c.is_ascii_digit()) {
            return bad("can't begin with a digit");
        }
        match validate_part(self.prefix) {
            Ok(()) => Ok(()),
            Err(_) => bad("isn't valid in a file name"),
        }
    }

    /// The indexes of this numbering's interval that are in use in `parent`: those of its full folders — and, when
    /// `count_short_folders`, also of any folder that is just the short name (a pair whose full folder went missing).
    fn indexes_in_use(&self, parent: &Path, count_short_folders: bool) -> io::Result<BTreeSet<u32>> {
        let mut used = BTreeSet::new();
        let entries = match std::fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(used),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let index = self.parse(&name).map(|(index, _)| index).or_else(|| if count_short_folders { self.parse_short(&name) } else { None });
            used.extend(index.filter(|index| self.interval.contains(*index)));
        }
        Ok(used)
    }

    /// The index the next pair in `parent` gets — the interval's start if `parent` has none of this numbering's pairs
    /// (or doesn't exist yet). An error if the interval is full (for `AfterLargest`: if nothing lies beyond the
    /// furthest index in use, whatever gaps there are behind it).
    pub fn next_index(&self, parent: &Path) -> io::Result<u32> {
        let interval = self.interval;
        let used = self.indexes_in_use(parent, self.indexing == Indexing::FillGaps)?;
        let step = |index: u32| if interval.descends() { index.checked_sub(1) } else { index.checked_add(1) };
        let candidate = match self.indexing {
            Indexing::AfterLargest => {
                let furthest = if interval.descends() { used.first() } else { used.last() };
                furthest.map_or(Some(interval.from), |furthest| step(*furthest))
            }
            Indexing::FillGaps => {
                let mut index = interval.from;
                loop {
                    if !used.contains(&index) {
                        break Some(index);
                    }
                    match step(index) {
                        Some(next) => index = next,
                        None => break None,
                    }
                }
            }
        };
        candidate
            .filter(|index| interval.contains(*index))
            .ok_or_else(|| io::Error::other(format!("No free index from {} to {} in {}.", interval.from, interval.to, parent.display())))
    }

    /// Creates a new pair for `part` in `parent` (creating `parent` if need be), its index chosen by [`next_index`].
    /// The caller makes sure there isn't one for `part` already (see `find`, `ensure`); callers that can race must
    /// serialise.
    pub fn create(&self, parent: &Path, part: &str) -> io::Result<FolderPair> {
        self.check_prefix()?;
        std::fs::create_dir_all(parent)?;
        let pair = self.make_pair(parent, self.next_index(parent)?, part);
        std::fs::create_dir(&pair.short_dir)?;
        std::fs::create_dir(&pair.full_dir)?;
        mark_full_dir(&pair.full_dir)?;
        Ok(pair)
    }

    /// Every pair of this numbering in `parent` (those with its prefix, whose index is in its interval), by index — the
    /// order of a descending interval's own direction is the reverse. (One is listed for each full folder, even if its
    /// short folder has gone missing.)
    pub fn list(&self, parent: &Path) -> io::Result<Vec<(FolderPair, String)>> {
        let mut pairs = Vec::new();
        let entries = match std::fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(pairs),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some((index, part)) = self.parse(&name).filter(|(index, _)| self.interval.contains(*index)) {
                pairs.push((self.make_pair(parent, index, part), part.to_string()));
            }
        }
        pairs.sort_by_key(|(pair, _)| pair.index);
        Ok(pairs)
    }

    /// The pair whose full name part is exactly `part`, if `parent` has one.
    pub fn find(&self, parent: &Path, part: &str) -> io::Result<Option<FolderPair>> {
        Ok(self.list(parent)?.into_iter().find(|(_, p)| p == part).map(|(pair, _)| pair))
    }

    /// The pair for `part`, creating it or repairing a missing short folder or `keepFile` if needed. For a fixed index
    /// (an interval of one) this is "the pair with that number, made if it isn't there": it fails if another pair holds it.
    pub fn ensure(&self, parent: &Path, part: &str) -> io::Result<FolderPair> {
        match self.find(parent, part)? {
            Some(pair) => {
                std::fs::create_dir_all(&pair.short_dir)?;
                mark_full_dir(&pair.full_dir)?;
                Ok(pair)
            }
            None => self.create(parent, part),
        }
    }

    /// Deletes both folders of the pair for `part` (and everything in the short one). Returns whether
    /// there was one.
    pub fn delete(&self, parent: &Path, part: &str) -> io::Result<bool> {
        let Some(pair) = self.find(parent, part)? else { return Ok(false) };
        for dir in [&pair.short_dir, &pair.full_dir] {
            match std::fs::remove_dir_all(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    /// Gives every pair of this numbering in `parent` its `keepFile` if it lacks one — the pairs made before the rule
    /// existed, or whose marker was lost on the way somewhere. Returns how many it wrote. (`ensure` does the same for the
    /// one pair it is asked about.)
    pub fn repair(&self, parent: &Path) -> io::Result<usize> {
        let mut written = 0;
        for (pair, _) in self.list(parent)? {
            if mark_full_dir(&pair.full_dir)? {
                written += 1;
            }
        }
        Ok(written)
    }
}

/// Makes sure `full_dir` (which is made if it is missing) holds its `keepFile`, with the right content. Returns whether
/// it had to write it.
fn mark_full_dir(full_dir: &Path) -> io::Result<bool> {
    std::fs::create_dir_all(full_dir)?;
    let keep = full_dir.join(keep_file());
    if std::fs::read(&keep).is_ok_and(|content| content == keep_content().as_bytes()) {
        return Ok(false);
    }
    std::fs::write(&keep, keep_content())?;
    Ok(true)
}

/// Renames a pair — both folders — to `to`'s names for `to_index` (which must be in its interval), keeping the full name
/// part. Fails, having changed nothing, if a folder of the new names is there already. Returns the pair as it is now.
#[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
pub fn rename(parent: &Path, pair: &FolderPair, to: &Numbering, to_index: u32) -> io::Result<FolderPair> {
    to.check_prefix()?;
    if !to.interval.contains(to_index) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{to_index} isn't in the interval {} to {}.", to.interval.from, to.interval.to)));
    }
    let renamed = to.make_pair(parent, to_index, &pair.part);
    if renamed.short_dir == pair.short_dir && renamed.full_dir == pair.full_dir {
        return Ok(renamed);
    }
    for dir in [&renamed.short_dir, &renamed.full_dir] {
        if dir.exists() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is there already.", dir.display())));
        }
    }
    let short_moved = pair.short_dir.exists();
    if short_moved {
        std::fs::rename(&pair.short_dir, &renamed.short_dir)?;
    }
    if let Err(e) = std::fs::rename(&pair.full_dir, &renamed.full_dir) {
        if short_moved {
            let _ = std::fs::rename(&renamed.short_dir, &pair.short_dir); // put the first one back: a pair is renamed whole or not at all
        }
        return Err(e);
    }
    Ok(renamed)
}

/// Renumbers many pairs at once: each of `moves` is a pair of `from` and the index it gets in `to`. **Two phases**, so that
/// a new name never collides with an old one that hasn't moved yet (swapping `001` and `002`, or shifting a whole run by
/// one): first every pair is renamed to `TEMPORARY_PREFIX` (in the config) (`from.temporary()`) with its own index, then every one to
/// its final name. Everything that can be checked is checked before the first rename: the new indexes must be distinct and
/// in `to`'s interval, and no folder that isn't one of the moving pairs may already have one of the new names. If a rename
/// fails midway the pairs that got that far keep the temporary prefix — `list` them with `from.temporary()` and call
/// `reassign` again, `from` being that (the first phase then has nothing to do).
#[allow(dead_code)] // for the note system (Notes persistence, to come): tested, not called by the app yet
pub fn reassign(parent: &Path, from: &Numbering, to: &Numbering, moves: &[(FolderPair, u32)]) -> io::Result<Vec<FolderPair>> {
    let invalid = |message: String| Err(io::Error::new(io::ErrorKind::InvalidInput, message));
    from.check_prefix()?;
    to.check_prefix()?;
    let mut seen = BTreeSet::new();
    let mut leaving = BTreeSet::new();
    for (pair, index) in moves {
        if !seen.insert(*index) {
            return invalid(format!("{index} is given to more than one pair."));
        }
        if !to.interval.contains(*index) {
            return invalid(format!("{index} isn't in the interval {} to {}.", to.interval.from, to.interval.to));
        }
        leaving.insert(pair.short_dir.clone());
        leaving.insert(pair.full_dir.clone());
    }
    for (pair, index) in moves {
        let target = to.make_pair(parent, *index, &pair.part);
        for dir in [&target.short_dir, &target.full_dir] {
            if dir.exists() && !leaving.contains(dir) {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is there already.", dir.display())));
            }
        }
    }

    let temporary = from.temporary();
    if from.prefix != temporary_prefix() {
        for (pair, _) in moves {
            let held = temporary.make_pair(parent, pair.index, &pair.part);
            for dir in [&held.short_dir, &held.full_dir] {
                if dir.exists() && !leaving.contains(dir) {
                    return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is there already.", dir.display())));
                }
            }
        }
    }
    let mut waiting = Vec::with_capacity(moves.len());
    for (pair, index) in moves {
        let held = if from.prefix == temporary_prefix() { pair.clone() } else { rename(parent, pair, &temporary, pair.index)? };
        waiting.push((held, *index));
    }
    waiting.iter().map(|(held, index)| rename(parent, held, to, *index)).collect()
}

/// Makes `text` safe to use as (part of) a folder name on every platform: characters that can't
/// appear in a Windows file name become `_`, and so do control characters; trailing dots and spaces
/// (which Windows drops) are removed; it's cut to `maxNamePartChars`.
pub fn sanitize_part(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .take(max_name_part_chars())
        .collect();
    cleaned.trim_end_matches(['.', ' ']).to_string()
}

/// Checks a name the user chose for a pair's full name part (a branch's name): non-empty, at most
/// `maxNamePartChars` characters, and valid as a file name on every platform.
pub fn validate_part(name: &str) -> Result<(), String> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name.trim().is_empty() {
        return Err("Give it a name.".to_string());
    }
    if name.chars().count() > max_name_part_chars() {
        return Err(format!("The name can be at most {} characters.", max_name_part_chars()));
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

    const DEFAULT: Numbering = Numbering::DEFAULT;
    const AFTER: Numbering = Numbering { indexing: Indexing::AfterLargest, ..Numbering::DEFAULT };

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csdrive-folder-pairs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn names(parent: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(parent).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn names_are_padded_and_parsed_back() {
        assert_eq!(DEFAULT.short_name(1), "001");
        assert_eq!(DEFAULT.short_name(42), "042");
        assert_eq!(DEFAULT.short_name(1000), "1000");
        assert_eq!(DEFAULT.full_name(7, "filen@@a@b.com@@12"), "007-filen@@a@b.com@@12");

        assert_eq!(DEFAULT.parse("007-filen@@a@b.com@@12"), Some((7, "filen@@a@b.com@@12")));
        assert_eq!(DEFAULT.parse("1000-big"), Some((1000, "big")));
        assert_eq!(DEFAULT.parse("001-"), Some((1, "")));
        assert_eq!(DEFAULT.parse("001"), None, "a short folder has no dash");
        assert_eq!(DEFAULT.parse("12-x"), None, "fewer than three digits");
        assert_eq!(DEFAULT.parse("abc-001"), None);
        assert_eq!(DEFAULT.parse("001x-y"), None);
        assert_eq!(DEFAULT.parse("-001"), None);
        assert_eq!(DEFAULT.parse("t_001-x"), None, "another prefix is not this numbering's");
        assert_eq!(DEFAULT.parse("0001-x"), None, "extra zeros: not how this numbering writes 1");
    }

    #[test]
    fn a_prefix_and_a_digit_count_are_part_of_the_names() {
        let internals = Numbering::new("", Interval::ascending(1, 9, 2), Indexing::FillGaps);
        assert_eq!(internals.short_name(1), "01");
        assert_eq!(internals.full_name(2, "[note-internals]"), "02-[note-internals]");
        assert_eq!(internals.parse("01-[note-files]"), Some((1, "[note-files]")));
        assert_eq!(internals.parse("1-x"), None);
        assert_eq!(internals.parse("001-x"), None, "three digits for 1 is a three-digit numbering's way of writing it");
        assert_eq!(DEFAULT.parse("01-x"), None, "and two digits are not enough for that one");
        let marked = Numbering::new("n_", Interval::ascending(1, 999, 3), Indexing::FillGaps);
        assert_eq!(marked.full_name(5, "x"), "n_005-x");
        assert_eq!(marked.parse("n_005-x"), Some((5, "x")));
        assert_eq!(marked.parse("005-x"), None, "no prefix");
        assert_eq!(DEFAULT.temporary().prefix, "t_");
        assert_eq!(DEFAULT.temporary().full_name(5, "x"), "t_005-x");
        // A prefix that begins with a digit, or isn't a valid name, is refused.
        let parent = scratch("prefix");
        assert!(Numbering::new("1x", DEFAULT.interval, DEFAULT.indexing).create(&parent, "a").is_err());
        assert!(Numbering::new("a/b", DEFAULT.interval, DEFAULT.indexing).create(&parent, "a").is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn the_next_index_is_one_more_than_the_largest_seen_on_disk() {
        let parent = scratch("next");
        assert_eq!(AFTER.next_index(&parent).unwrap(), 1, "a parent that doesn't exist yet");
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(AFTER.next_index(&parent).unwrap(), 1, "an empty parent");

        for name in ["001", "001-a", "003-c", "notes.txt", "12-ignored", "002"] {
            std::fs::create_dir(parent.join(name)).unwrap();
        }
        assert_eq!(AFTER.next_index(&parent).unwrap(), 4, "gaps aren't filled; short folders and others don't count");
        std::fs::remove_dir(parent.join("003-c")).unwrap();
        assert_eq!(AFTER.next_index(&parent).unwrap(), 2, "an index freed by deleting the newest pair is reused");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn filling_gaps_takes_the_lowest_index_nobody_uses() {
        let parent = scratch("gaps");
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 1, "a parent that doesn't exist yet");
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 1, "an empty parent");

        for name in ["001-a", "003-c", "notes.txt", "12-ignored"] {
            std::fs::create_dir(parent.join(name)).unwrap();
        }
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 2, "the gap between 001 and 003");
        std::fs::create_dir(parent.join("002-b")).unwrap();
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 4);
        std::fs::remove_dir(parent.join("001-a")).unwrap();
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 1, "a freed index at the front comes back");

        // A bare short folder counts as in use (its full folder went missing), so nothing can collide with it.
        std::fs::create_dir(parent.join("001")).unwrap();
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 4);
        std::fs::remove_dir(parent.join("002-b")).unwrap();
        assert_eq!(DEFAULT.next_index(&parent).unwrap(), 2);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_descending_interval_counts_down_from_its_start() {
        let parent = scratch("down");
        let items = Numbering::new("", Interval::descending(999, 401, 3), Indexing::FillGaps);
        let after = Numbering { indexing: Indexing::AfterLargest, ..items };
        assert_eq!(items.next_index(&parent).unwrap(), 999, "the start, in a parent that isn't there");
        for name in ["999-a", "997-c", "998-b"] {
            std::fs::create_dir_all(parent.join(name)).unwrap();
        }
        assert_eq!(items.next_index(&parent).unwrap(), 996);
        std::fs::remove_dir(parent.join("998-b")).unwrap();
        assert_eq!(items.next_index(&parent).unwrap(), 998, "first free: the gap");
        assert_eq!(after.next_index(&parent).unwrap(), 996, "after the largest: one step past the furthest in use (997)");
        // Indexes outside the interval are somebody else's.
        std::fs::create_dir(parent.join("150-elsewhere")).unwrap();
        std::fs::create_dir(parent.join("400-just-outside")).unwrap();
        assert_eq!(after.next_index(&parent).unwrap(), 996);
        assert_eq!(items.list(&parent).unwrap().iter().map(|(p, _)| p.index).collect::<Vec<_>>(), [997, 999], "only its own");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn an_interval_that_is_full_says_so() {
        let parent = scratch("full");
        let two = Numbering::new("", Interval::ascending(1, 2, 3), Indexing::FillGaps);
        assert_eq!(two.create(&parent, "a").unwrap().index, 1);
        assert_eq!(two.create(&parent, "b").unwrap().index, 2);
        let error = two.create(&parent, "c").unwrap_err();
        assert!(error.to_string().contains("No free index from 1 to 2"), "{error}");
        assert_eq!(names(&parent).len(), 4, "nothing was made");
        // After the largest: gaps behind the furthest index don't help.
        let after = Numbering { indexing: Indexing::AfterLargest, ..two };
        assert!(two.delete(&parent, "a").unwrap());
        assert!(after.create(&parent, "again").is_err(), "2 is the last index and it is in use");
        assert_eq!(two.create(&parent, "again").unwrap().index, 1, "first free does find the gap");
        // Going down to 0 doesn't wrap around.
        let down = Numbering::new("", Interval::descending(2, 0, 3), Indexing::AfterLargest);
        let other = scratch("full-down");
        assert_eq!(down.create(&other, "a").unwrap().index, 2);
        assert_eq!(down.create(&other, "b").unwrap().index, 1);
        assert_eq!(down.create(&other, "c").unwrap().index, 0);
        assert!(down.create(&other, "d").is_err());
        let _ = (std::fs::remove_dir_all(&parent), std::fs::remove_dir_all(&other));
    }

    #[test]
    fn a_fixed_index_is_a_pair_that_is_made_once_and_found_after() {
        let parent = scratch("fixed");
        let files = Numbering::new("", Interval::fixed(1, 2), Indexing::FillGaps);
        let internals = Numbering::new("", Interval::fixed(2, 2), Indexing::FillGaps);
        let made = files.ensure(&parent, "[note-files]").unwrap();
        assert_eq!((made.index, made.full_name.as_str()), (1, "01-[note-files]"));
        assert_eq!(files.ensure(&parent, "[note-files]").unwrap(), made, "the same pair the second time");
        assert_eq!(internals.ensure(&parent, "[note-internals]").unwrap().full_name, "02-[note-internals]");
        assert_eq!(names(&parent), ["01", "01-[note-files]", "02", "02-[note-internals]"]);
        // Somebody else holds the number: no pair is made.
        assert!(files.create(&parent, "other").is_err());
        assert!(files.ensure(&parent, "[note-files-renamed]").is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn several_numberings_share_a_parent_each_owning_its_own_interval() {
        // The note system's: items 999→401, primary sections 199→111, secondary 299→201, ternary 399→301, internals 01–03.
        let items = Numbering::new("", Interval::descending(999, 401, 3), Indexing::AfterLargest);
        let primary = Numbering::new("", Interval::descending(199, 111, 3), Indexing::AfterLargest);
        let secondary = Numbering::new("", Interval::descending(299, 201, 3), Indexing::AfterLargest);
        let ternary = Numbering::new("", Interval::descending(399, 301, 3), Indexing::AfterLargest);
        let files = Numbering::new("", Interval::fixed(1, 2), Indexing::FillGaps);
        let notebook = Numbering::new("", Interval::fixed(3, 2), Indexing::FillGaps);
        let parent = scratch("shared");

        assert_eq!(files.ensure(&parent, "[note-files]").unwrap().full_name, "01-[note-files]");
        assert_eq!(notebook.ensure(&parent, "[note-book]").unwrap().full_name, "03-[note-book]");
        assert_eq!(items.create(&parent, "first note").unwrap().full_name, "999-first note");
        assert_eq!(items.create(&parent, "second note").unwrap().full_name, "998-second note");
        assert_eq!(primary.create(&parent, "Work").unwrap().index, 199);
        assert_eq!(secondary.create(&parent, "Reports").unwrap().index, 299);
        assert_eq!(ternary.create(&parent, "Q3").unwrap().index, 399);
        assert_eq!(items.create(&parent, "third note").unwrap().index, 997, "the sections didn't take the items' numbers");
        assert_eq!(primary.create(&parent, "Home").unwrap().index, 198);

        // Each sees only its own; the number of digits alone tells the two-digit kind from the three-digit ones.
        let of = |n: &Numbering| n.list(&parent).unwrap().into_iter().map(|(p, _)| p.full_name).collect::<Vec<_>>();
        assert_eq!(of(&items), ["997-third note", "998-second note", "999-first note"]);
        assert_eq!(of(&primary), ["198-Home", "199-Work"]);
        assert_eq!(of(&secondary), ["299-Reports"]);
        assert_eq!(of(&ternary), ["399-Q3"]);
        assert_eq!(of(&files), ["01-[note-files]"]);
        assert_eq!(items.parse("01-[note-files]"), None, "two digits are not a three-digit kind");
        assert!(files.list(&parent).unwrap().iter().all(|(p, _)| p.index == 1), "a three-digit name is well-formed for the two-digit numbering, but its index isn't in its interval");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_pair_is_created_found_repaired_and_deleted() {
        let parent = scratch("pair");
        let first = AFTER.create(&parent, "filen@@a@x.com@@1").unwrap();
        let second = AFTER.create(&parent, "filen@@b@x.com@@2").unwrap();
        assert_eq!((first.index, second.index), (1, 2));
        assert!(first.short_dir.is_dir() && first.full_dir.is_dir());
        assert_eq!(first.full_name, "001-filen@@a@x.com@@1");
        assert_eq!(first.part, "filen@@a@x.com@@1");
        let held: Vec<_> = std::fs::read_dir(&first.full_dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(held, [keep_file()], "the full folder holds only its .keep");
        assert_eq!(std::fs::read_to_string(first.full_dir.join(keep_file())).unwrap(), "-", "with one dash in it");

        assert_eq!(AFTER.find(&parent, "filen@@b@x.com@@2").unwrap(), Some(second.clone()));
        assert_eq!(AFTER.find(&parent, "filen@@c@x.com@@3").unwrap(), None);
        assert_eq!(AFTER.list(&parent).unwrap().len(), 2);

        // `ensure` reuses a pair and repairs a missing short folder.
        std::fs::remove_dir(&first.short_dir).unwrap();
        assert_eq!(AFTER.ensure(&parent, "filen@@a@x.com@@1").unwrap(), first);
        assert!(first.short_dir.is_dir());
        assert_eq!(AFTER.list(&parent).unwrap().len(), 2, "no duplicate");

        std::fs::write(second.short_dir.join("data.txt"), "x").unwrap();
        assert!(AFTER.delete(&parent, "filen@@b@x.com@@2").unwrap());
        assert!(!second.short_dir.exists() && !second.full_dir.exists(), "both folders, and what was in them");
        assert!(!AFTER.delete(&parent, "filen@@b@x.com@@2").unwrap(), "already gone");

        assert_eq!(AFTER.create(&parent, "again").unwrap().index, 2, "the freed index is reused");

        // Filling gaps: 001 and 003 exist, so the new pair is 002 — created, whole, in the gap.
        let third = AFTER.create(&parent, "third").unwrap();
        assert_eq!(third.index, 3);
        assert!(AFTER.delete(&parent, "again").unwrap());
        let filled = DEFAULT.create(&parent, "filled").unwrap();
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
        assert_eq!(DEFAULT.repair(&parent).unwrap(), 2, "both got one");
        for full in ["001-old@@a", "002-old@@b"] {
            assert_eq!(std::fs::read_to_string(parent.join(full).join(keep_file())).unwrap(), "-", "{full}");
        }
        assert!(!parent.join("001").join(keep_file()).exists() && !parent.join("002").join(keep_file()).exists(), "the short folders are the data's and stay as they are");
        assert_eq!(std::fs::read_to_string(parent.join("002").join("data.txt")).unwrap(), "data");
        assert_eq!(DEFAULT.repair(&parent).unwrap(), 0, "nothing more to do");
        assert_eq!(DEFAULT.repair(&parent.join("nowhere")).unwrap(), 0, "a parent that isn't there has no pairs");

        // A marker with the wrong content, or one that got lost, is put right — by `repair` and by `ensure`.
        std::fs::write(parent.join("001-old@@a").join(keep_file()), "").unwrap();
        std::fs::remove_file(parent.join("002-old@@b").join(keep_file())).unwrap();
        assert_eq!(DEFAULT.repair(&parent).unwrap(), 2);
        std::fs::remove_file(parent.join("002-old@@b").join(keep_file())).unwrap();
        DEFAULT.ensure(&parent, "old@@b").unwrap();
        assert_eq!(std::fs::read_to_string(parent.join("002-old@@b").join(keep_file())).unwrap(), "-");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_pair_is_renamed_whole_or_not_at_all() {
        let parent = scratch("rename");
        let a = DEFAULT.create(&parent, "a").unwrap();
        let b = DEFAULT.create(&parent, "b").unwrap();
        std::fs::write(a.short_dir.join("data.txt"), "data").unwrap();
        let moved = rename(&parent, &a, &DEFAULT, 7).unwrap();
        assert_eq!((moved.short_name.as_str(), moved.full_name.as_str()), ("007", "007-a"));
        assert_eq!(std::fs::read_to_string(moved.short_dir.join("data.txt")).unwrap(), "data");
        assert_eq!(std::fs::read_to_string(moved.full_dir.join(keep_file())).unwrap(), "-");
        assert_eq!(names(&parent), ["002", "002-b", "007", "007-a"]);
        assert_eq!(rename(&parent, &moved, &DEFAULT, 7).unwrap(), moved, "to where it is: nothing to do");
        // Onto a name that's taken: refused, nothing moves.
        assert_eq!(rename(&parent, &moved, &DEFAULT, 2).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(names(&parent), ["002", "002-b", "007", "007-a"]);
        // Out of the interval: refused.
        let tens = Numbering::new("", Interval::ascending(1, 9, 3), Indexing::FillGaps);
        assert_eq!(rename(&parent, &b, &tens, 12).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        // A pair whose short folder is missing still moves its full folder.
        std::fs::remove_dir(&b.short_dir).unwrap();
        let lone = rename(&parent, &b, &DEFAULT, 3).unwrap();
        assert_eq!(names(&parent), ["003-b", "007", "007-a"]);
        assert!(lone.full_dir.is_dir());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn many_pairs_are_renumbered_through_the_temporary_prefix() {
        let parent = scratch("reassign");
        let pairs: Vec<FolderPair> = ["a", "b", "c"].iter().map(|part| DEFAULT.create(&parent, part).unwrap()).collect();
        for (pair, text) in pairs.iter().zip(["A", "B", "C"]) {
            std::fs::write(pair.short_dir.join("data.txt"), text).unwrap();
        }
        // Rotate: a 001→002, b 002→003, c 003→001 — every new name is an old one that hasn't moved yet.
        let moves = vec![(pairs[0].clone(), 2), (pairs[1].clone(), 3), (pairs[2].clone(), 1)];
        let now = reassign(&parent, &DEFAULT, &DEFAULT, &moves).unwrap();
        assert_eq!(now.iter().map(|p| p.full_name.as_str()).collect::<Vec<_>>(), ["002-a", "003-b", "001-c"]);
        assert_eq!(names(&parent), ["001", "001-c", "002", "002-a", "003", "003-b"], "no temporary name left behind");
        for (pair, text) in now.iter().zip(["A", "B", "C"]) {
            assert_eq!(std::fs::read_to_string(pair.short_dir.join("data.txt")).unwrap(), text, "the data went with its pair");
            assert_eq!(std::fs::read_to_string(pair.full_dir.join(keep_file())).unwrap(), "-");
        }

        // Checked before anything moves: a repeated index, one outside the interval, a name a stranger holds.
        let before = names(&parent);
        assert!(reassign(&parent, &DEFAULT, &DEFAULT, &[(now[0].clone(), 5), (now[1].clone(), 5)]).is_err());
        let small = Numbering::new("", Interval::ascending(1, 9, 3), Indexing::FillGaps);
        assert!(reassign(&parent, &DEFAULT, &small, &[(now[0].clone(), 50)]).is_err());
        std::fs::create_dir(parent.join("009")).unwrap();
        assert!(reassign(&parent, &DEFAULT, &DEFAULT, &[(now[0].clone(), 9)]).is_err(), "009 is taken by a folder that isn't moving");
        std::fs::remove_dir(parent.join("009")).unwrap();
        std::fs::create_dir(parent.join("t_002")).unwrap();
        assert!(reassign(&parent, &DEFAULT, &DEFAULT, &[(now[0].clone(), 9)]).is_err(), "so is the temporary name of the pair that would move");
        std::fs::remove_dir(parent.join("t_002")).unwrap();
        assert_eq!(names(&parent), before, "nothing moved");

        // Into another numbering — a different interval, digits and prefix — in one go.
        let notes = Numbering::new("n", Interval::descending(999, 401, 3), Indexing::AfterLargest);
        let moved = reassign(&parent, &DEFAULT, &notes, &[(now[0].clone(), 999), (now[1].clone(), 998)]).unwrap();
        assert_eq!(moved.iter().map(|p| p.full_name.as_str()).collect::<Vec<_>>(), ["n999-a", "n998-b"]);
        assert_eq!(notes.list(&parent).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn an_interrupted_renumbering_can_be_finished_from_the_temporary_prefix() {
        let parent = scratch("resume");
        let a = DEFAULT.create(&parent, "a").unwrap();
        let b = DEFAULT.create(&parent, "b").unwrap();
        // The first phase ran; the second did not.
        rename(&parent, &a, &DEFAULT.temporary(), a.index).unwrap();
        rename(&parent, &b, &DEFAULT.temporary(), b.index).unwrap();
        assert_eq!(names(&parent), ["t_001", "t_001-a", "t_002", "t_002-b"]);
        assert!(DEFAULT.list(&parent).unwrap().is_empty(), "under the ordinary prefix they don't show");
        let waiting: Vec<(FolderPair, u32)> = DEFAULT.temporary().list(&parent).unwrap().into_iter().map(|(pair, _)| { let to = 3 - pair.index; (pair, to) }).collect();
        reassign(&parent, &DEFAULT.temporary(), &DEFAULT, &waiting).unwrap();
        assert_eq!(names(&parent), ["001", "001-b", "002", "002-a"], "swapped, finished");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn names_are_sanitised_and_validated() {
        assert_eq!(sanitize_part("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_part("trailing. . "), "trailing");
        assert_eq!(sanitize_part(&"x".repeat(300)).chars().count(), max_name_part_chars());
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
