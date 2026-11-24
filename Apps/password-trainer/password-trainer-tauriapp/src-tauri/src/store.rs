//! The list of passwords to train, persisted as JSON in the app data folder.
//!
//! Only Argon2id hashes (PHC strings, each with its own random salt) are ever stored — never a password.
//! Hashes never leave this module either: the frontend sees ids and labels, and asks [`Store::verify`].

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "passwords.json";
const FORMAT_VERSION: u32 = 1;
const MAX_LABEL_CHARS: usize = 200;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    label: String,
    /// Argon2id PHC string (`$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`).
    hash: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    entries: Vec<Entry>,
}

/// What the frontend gets for an entry: no hash.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub updated_at: u64,
}

pub struct Store {
    path: PathBuf,
    entries: Vec<Entry>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn clean_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("The label can't be empty.".into());
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!("The label can't be longer than {MAX_LABEL_CHARS} characters."));
    }
    Ok(label.to_string())
}

/// Hashing is deliberately slow (that is what makes a stolen hash hard to crack), so callers run it off the main thread.
pub fn hash_password(password: &str) -> Result<String, String> {
    if password.is_empty() {
        return Err("The password can't be empty.".into());
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("Couldn't hash the password: {e}"))
}

pub fn verify_hash(hash: &str, password: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(hash).map_err(|e| format!("The stored hash is damaged: {e}"))?;
    Ok(Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

impl Store {
    pub fn open(dir: &Path) -> Result<Store, String> {
        let path = dir.join(FILE_NAME);
        let entries = match fs::read_to_string(&path) {
            Ok(text) => {
                let file: StoreFile = serde_json::from_str(&text)
                    .map_err(|e| format!("{} is damaged and was left untouched: {e}", path.display()))?;
                if file.version > FORMAT_VERSION {
                    return Err(format!("{} was written by a newer version of the app.", path.display()));
                }
                file.entries
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
        };
        Ok(Store { path, entries })
    }

    /// Writes to a temporary file and renames it over the real one, so a crash never leaves half a file.
    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        }
        let file = StoreFile { version: FORMAT_VERSION, entries: self.entries.clone() };
        let mut text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        text.push('\n');
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
            f.write_all(text.as_bytes()).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
            f.sync_all().map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| format!("Couldn't save {}: {e}", self.path.display()))
    }

    pub fn list(&self) -> Vec<EntryView> {
        self.entries
            .iter()
            .map(|e| EntryView { id: e.id.clone(), label: e.label.clone(), created_at: e.created_at, updated_at: e.updated_at })
            .collect()
    }

    fn find(&self, id: &str) -> Result<usize, String> {
        self.entries.iter().position(|e| e.id == id).ok_or_else(|| "That password no longer exists.".to_string())
    }

    pub fn hash_of(&self, id: &str) -> Result<String, String> {
        Ok(self.entries[self.find(id)?].hash.clone())
    }

    /// Adds at the top of the list. `hash` comes from [`hash_password`].
    pub fn add(&mut self, label: &str, hash: String) -> Result<Vec<EntryView>, String> {
        let label = clean_label(label)?;
        let t = now_ms();
        self.entries.insert(0, Entry { id: uuid::Uuid::new_v4().to_string(), label, hash, created_at: t, updated_at: t });
        if let Err(e) = self.save() {
            self.entries.remove(0);
            return Err(e);
        }
        Ok(self.list())
    }

    /// Changes the label and, when `hash` is given, the password.
    pub fn update(&mut self, id: &str, label: &str, hash: Option<String>) -> Result<Vec<EntryView>, String> {
        let label = clean_label(label)?;
        let i = self.find(id)?;
        let before = self.entries[i].clone();
        let entry = &mut self.entries[i];
        entry.label = label;
        if let Some(h) = hash {
            entry.hash = h;
        }
        entry.updated_at = now_ms();
        if let Err(e) = self.save() {
            self.entries[i] = before;
            return Err(e);
        }
        Ok(self.list())
    }

    pub fn delete(&mut self, ids: &[String]) -> Result<Vec<EntryView>, String> {
        let before = self.entries.clone();
        self.entries.retain(|e| !ids.contains(&e.id));
        if let Err(e) = self.save() {
            self.entries = before;
            return Err(e);
        }
        Ok(self.list())
    }

    /// `ids` must be exactly the current ids, in their new order.
    pub fn reorder(&mut self, ids: &[String]) -> Result<Vec<EntryView>, String> {
        if ids.len() != self.entries.len() {
            return Err("The list changed meanwhile; please try again.".into());
        }
        let mut next = Vec::with_capacity(ids.len());
        for id in ids {
            let i = self.find(id)?;
            if next.iter().any(|e: &Entry| &e.id == id) {
                return Err("The new order names a password twice.".into());
            }
            next.push(self.entries[i].clone());
        }
        let before = std::mem::replace(&mut self.entries, next);
        if let Err(e) = self.save() {
            self.entries = before;
            return Err(e);
        }
        Ok(self.list())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("password-trainer-test-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hashes_verify_and_never_contain_the_password() {
        let h = hash_password("correct horse").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(!h.contains("correct horse"));
        assert!(verify_hash(&h, "correct horse").unwrap());
        assert!(!verify_hash(&h, "correct horse ").unwrap());
        assert_ne!(h, hash_password("correct horse").unwrap(), "each hash has its own salt");
    }

    #[test]
    fn persists_edits_order_and_deletes() {
        let dir = temp_dir("persist");
        let mut s = Store::open(&dir).unwrap();
        s.add("first", hash_password("a").unwrap()).unwrap();
        s.add("second", hash_password("b").unwrap()).unwrap();
        let ids: Vec<String> = s.list().iter().map(|e| e.id.clone()).collect();
        assert_eq!(s.list()[0].label, "second");
        s.reorder(&[ids[1].clone(), ids[0].clone()]).unwrap();
        s.update(&ids[0], "  renamed  ", Some(hash_password("c").unwrap())).unwrap();

        let s2 = Store::open(&dir).unwrap();
        let labels: Vec<String> = s2.list().iter().map(|e| e.label.clone()).collect();
        assert_eq!(labels, ["first", "renamed"]);
        assert!(verify_hash(&s2.hash_of(&ids[0]).unwrap(), "c").unwrap());
        assert!(!fs::read_to_string(dir.join(FILE_NAME)).unwrap().contains("\"c\""));

        let mut s3 = s2;
        s3.delete(&[ids[1].clone()]).unwrap();
        assert_eq!(Store::open(&dir).unwrap().list().len(), 1);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_bad_input() {
        let dir = temp_dir("bad");
        let mut s = Store::open(&dir).unwrap();
        assert!(hash_password("").is_err());
        assert!(s.add("   ", hash_password("x").unwrap()).is_err());
        s.add("one", hash_password("x").unwrap()).unwrap();
        let id = s.list()[0].id.clone();
        assert!(s.reorder(&[]).is_err());
        assert!(s.reorder(&["nope".into()]).is_err());
        assert!(s.reorder(&[id.clone()]).is_ok());
        fs::remove_dir_all(dir).ok();
    }
}
