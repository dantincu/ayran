//! **The constants of the folder pairs and the notes**, in one file: `csdrive-webhost-tauriapp/config/folder-pairs-and-notes.json`.
//!
//! The file is *compiled in* — `include_str!` here, and the frontend bundles the same file (`src/lib/appConfig.ts`) — so it is inside
//! every installer and APK, and nothing on a person's machine can change it. To change a constant, edit the file and rebuild. It is read
//! once, checked (`validate`: a bad file stops the app at its first use, and the test below stops the build), and then never changes.
//!
//! What is in it: the folder pairs' `.keep` file and its content, the temporary prefix, the longest name part, the default numbering
//! (what the Filen cache's accounts and branches use), and everything the notes call by name — `[note].json`, `[note-children].json`,
//! `[note-book].json`, the markdown's prefix and suffix, the four numberings of the note items and sections, and the internals' pairs.

use std::sync::{LazyLock, OnceLock};

use serde::Deserialize;

use crate::folder_pairs::{Indexing, Interval, Numbering};

const SOURCE: &str = include_str!("../../config/folder-pairs-and-notes.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub folder_pairs: FolderPairsConfig,
    pub notes: NotesConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPairsConfig {
    pub keep_file: String,
    pub keep_content: String,
    pub temporary_prefix: String,
    pub max_name_part_chars: usize,
    /// The storage provider named in a cached account's folder (`filen@@<email>@@<id>`).
    pub account_provider: String,
    pub default_numbering: NumberingConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesConfig {
    pub files: NoteFilesConfig,
    pub markdown: MarkdownNamesConfig,
    pub numberings: NoteNumberings,
    pub internals: NoteInternals,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFilesConfig {
    pub notebook: String,
    pub note: String,
    pub children: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownNamesConfig {
    #[allow(dead_code)] // read by the frontend (same file); kept here so the file is checked as a whole
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteNumberings {
    pub note_items: NumberingConfig,
    pub primary_sections: NumberingConfig,
    pub secondary_sections: NumberingConfig,
    pub ternary_sections: NumberingConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInternals {
    pub note_files: NumberingConfig,
    pub note_internals: NumberingConfig,
    pub notebook: NumberingConfig,
}

/// A numbering as the file writes it (see `folder_pairs::Numbering`): a prefix, an interval (`from` → `to`, the direction being
/// which is larger), digits, and how a new pair picks its index.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberingConfig {
    #[serde(default)]
    #[allow(dead_code)] // for the frontend, which shows it
    pub label: String,
    #[serde(default)]
    pub prefix: String,
    pub from: u32,
    pub to: u32,
    pub digits: usize,
    pub indexing: IndexingConfig,
    /// The internals' pairs: the fixed full-folder-name part.
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IndexingConfig {
    FillGaps,
    AfterLargest,
}

impl NumberingConfig {
    /// The `Numbering` this describes. (The prefix is kept for the life of the process: numberings are `Copy`.)
    pub fn numbering(&self) -> Numbering {
        let prefix: &'static str = Box::leak(self.prefix.clone().into_boxed_str());
        let interval = if self.from <= self.to { Interval::ascending(self.from, self.to, self.digits) } else { Interval::descending(self.from, self.to, self.digits) };
        let indexing = match self.indexing {
            IndexingConfig::FillGaps => Indexing::FillGaps,
            IndexingConfig::AfterLargest => Indexing::AfterLargest,
        };
        Numbering::new(prefix, interval, indexing)
    }
}

/// The checked configuration (parsed on first use).
pub fn get() -> &'static Config {
    static CONFIG: OnceLock<Config> = OnceLock::new();
    CONFIG.get_or_init(|| {
        let config: Config = serde_json::from_str(SOURCE).expect("config/folder-pairs-and-notes.json isn't valid");
        if let Err(problem) = validate(&config) {
            panic!("config/folder-pairs-and-notes.json: {problem}");
        }
        config
    })
}

/// What the Filen cache's accounts and branches are numbered by.
pub static DEFAULT_NUMBERING: LazyLock<Numbering> = LazyLock::new(|| get().folder_pairs.default_numbering.numbering());

fn invalid_name(name: &str) -> bool {
    name.is_empty() || name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
}

/// The rules the values must keep: the numberings' intervals don't overlap (nothing else would keep several numberings apart in one
/// parent folder), a prefix can't start with a digit, names are file names, digits are enough for the interval's largest index.
pub fn validate(config: &Config) -> Result<(), String> {
    let pairs = &config.folder_pairs;
    if invalid_name(&pairs.keep_file) || pairs.keep_content.is_empty() {
        return Err("the keep file needs a name and a content".into());
    }
    if pairs.temporary_prefix.is_empty() || invalid_name(&pairs.temporary_prefix) || pairs.temporary_prefix.starts_with(|c: char| c.is_ascii_digit()) {
        return Err("the temporary prefix must be a file name part that doesn't begin with a digit".into());
    }
    if !(10..=200).contains(&pairs.max_name_part_chars) {
        return Err("the longest name part must be 10 to 200 characters".into());
    }
    let notes = &config.notes;
    for name in [&notes.files.notebook, &notes.files.note, &notes.files.children, &notes.markdown.suffix] {
        if invalid_name(name) {
            return Err(format!("\"{name}\" isn't a usable file name"));
        }
    }
    let n = &notes.numberings;
    let internals = &notes.internals;
    let all: Vec<(&str, &NumberingConfig)> = vec![
        ("default numbering", &pairs.default_numbering),
        ("noteItems", &n.note_items),
        ("primarySections", &n.primary_sections),
        ("secondarySections", &n.secondary_sections),
        ("ternarySections", &n.ternary_sections),
        ("noteFiles", &internals.note_files),
        ("noteInternals", &internals.note_internals),
        ("notebook", &internals.notebook),
    ];
    for (key, numbering) in &all {
        if numbering.prefix.starts_with(|c: char| c.is_ascii_digit()) || numbering.prefix.chars().any(|c| invalid_name(&c.to_string())) {
            return Err(format!("{key}: a prefix must be valid in a file name and not begin with a digit"));
        }
        if numbering.digits < 1 || numbering.digits > 9 {
            return Err(format!("{key}: digits must be 1 to 9"));
        }
        let widest = numbering.from.max(numbering.to);
        if widest != u32::MAX && widest.to_string().len() > numbering.digits {
            return Err(format!("{key}: {widest} doesn't fit in {} digits", numbering.digits));
        }
    }
    // The four numberings of the note items and sections (three digits) share a parent folder: their intervals must not overlap.
    let kinds: Vec<(&str, &NumberingConfig)> = all[1..5].to_vec();
    for (i, (a_key, a)) in kinds.iter().enumerate() {
        for (b_key, b) in &kinds[i + 1..] {
            let (a_low, a_high) = (a.from.min(a.to), a.from.max(a.to));
            let (b_low, b_high) = (b.from.min(b.to), b.from.max(b.to));
            if a.prefix == b.prefix && a_low <= b_high && b_low <= a_high {
                return Err(format!("{a_key} and {b_key} overlap"));
            }
        }
    }
    // The internals are two digits, so they can never be taken for a three-digit note.
    for (key, numbering) in &all[5..] {
        if numbering.digits != 2 || numbering.from != numbering.to || numbering.name.is_empty() {
            return Err(format!("{key}: an internal pair is a constant (one index), of two digits, with a name"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_file_is_valid_and_says_what_the_strategy_says() {
        let config = get();
        assert_eq!(config.folder_pairs.keep_file, ".keep");
        assert_eq!(config.folder_pairs.keep_content, "-");
        assert_eq!(config.folder_pairs.temporary_prefix, "t_");
        assert_eq!(config.folder_pairs.max_name_part_chars, 100);
        assert_eq!(config.notes.files.children, "[note-children].json");
        let items = &config.notes.numberings.note_items;
        assert_eq!((items.from, items.to, items.digits), (999, 401, 3));
        assert_eq!(items.indexing, IndexingConfig::AfterLargest);
        let default = DEFAULT_NUMBERING.short_name(1);
        assert_eq!(default, "001", "the cache's pairs are numbered upward from 001 as before");
    }

    #[test]
    fn overlapping_numberings_and_bad_values_are_refused() {
        let good = get().clone();
        let mut overlap = good.clone();
        overlap.notes.numberings.primary_sections.from = 450;
        overlap.notes.numberings.primary_sections.to = 350;
        assert!(validate(&overlap).is_err(), "a section interval that runs into the note items'");
        let mut digit_prefix = good.clone();
        digit_prefix.folder_pairs.temporary_prefix = "1_".into();
        assert!(validate(&digit_prefix).is_err());
        let mut too_wide = good.clone();
        too_wide.notes.numberings.note_items.from = 1000;
        assert!(validate(&too_wide).is_err());
        let mut not_constant = good;
        not_constant.notes.internals.note_files.to = 5;
        assert!(validate(&not_constant).is_err());
    }
}
