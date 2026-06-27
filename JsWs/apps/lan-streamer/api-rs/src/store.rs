use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use uuid::Uuid;

use crate::config::DEFAULT_MAX_DEVICE_AMPLITUDE;
use crate::secure_store;
use crate::types::{AccountSettings, ActiveHost, HostAudioSource, Session, StreamMode, StreamRecord};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub struct Store {
    data_dir: PathBuf,
    streams: Mutex<HashMap<String, StreamRecord>>,
    sessions: Mutex<HashMap<String, Session>>,
    account_settings: Mutex<HashMap<i64, AccountSettings>>,
    // Guards both the in-memory cache and the on-disk key file, so the two
    // can never drift apart from a create-vs-create race the way they could
    // if persistence re-derived the key independently on every save.
    session_key: tokio::sync::Mutex<Option<[u8; 32]>>,
}

impl Store {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            streams: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            account_settings: Mutex::new(HashMap::new()),
            session_key: tokio::sync::Mutex::new(None),
        }
    }

    fn streams_file(&self) -> PathBuf {
        self.data_dir.join("streams.json")
    }
    fn sessions_file(&self) -> PathBuf {
        self.data_dir.join("sessions.enc")
    }
    fn session_key_file(&self) -> PathBuf {
        self.data_dir.join("session-key.bin")
    }
    fn account_settings_file(&self) -> PathBuf {
        self.data_dir.join("account-settings.json")
    }

    async fn persist_streams(&self) {
        let records: Vec<StreamRecord> = self.streams.lock().unwrap().values().cloned().collect();
        if let Err(err) = write_json(&self.data_dir, &self.streams_file(), &records).await {
            eprintln!("Failed to persist streams: {err}");
        }
    }

    pub async fn load_streams(&self) -> Result<(), String> {
        let path = self.streams_file();
        let Ok(raw) = tokio::fs::read_to_string(&path).await else {
            return Ok(());
        };
        let mut records: Vec<StreamRecord> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let mut streams = self.streams.lock().unwrap();
        for record in &mut records {
            // activeHosts/pausedHostAccountIds describe live WebSocket
            // connections, none of which can still exist right after the
            // process just started - reset them rather than trusting
            // whatever was last persisted.
            record.active_hosts = Vec::new();
            record.paused_host_account_ids = Vec::new();
            streams.insert(record.id.clone(), record.clone());
        }
        Ok(())
    }

    pub fn list_streams_for_account(&self, account_id: i64) -> Vec<StreamRecord> {
        self.streams.lock().unwrap().values().filter(|s| s.owner_account_id == account_id).cloned().collect()
    }

    pub fn get_stream(&self, id: &str) -> Option<StreamRecord> {
        self.streams.lock().unwrap().get(id).cloned()
    }

    pub async fn create_stream(&self, name: String, owner_account_id: i64, mode: StreamMode) -> StreamRecord {
        let record = StreamRecord {
            id: Uuid::new_v4().to_string(),
            name,
            mode,
            owner_account_id,
            created_at: now_ms(),
            active_hosts: Vec::new(),
            paused_host_account_ids: Vec::new(),
        };
        self.streams.lock().unwrap().insert(record.id.clone(), record.clone());
        self.persist_streams().await;
        record
    }

    pub async fn delete_stream(&self, id: &str, account_id: i64) -> bool {
        let removed = {
            let mut streams = self.streams.lock().unwrap();
            match streams.get(id) {
                Some(record) if record.owner_account_id == account_id => {
                    streams.remove(id);
                    true
                }
                _ => false,
            }
        };
        if removed {
            self.persist_streams().await;
        }
        removed
    }

    pub async fn set_host_paused(&self, stream_id: &str, account_id: i64, paused: bool) {
        {
            let mut streams = self.streams.lock().unwrap();
            if let Some(record) = streams.get_mut(stream_id) {
                record.paused_host_account_ids.retain(|id| *id != account_id);
                if paused {
                    record.paused_host_account_ids.push(account_id);
                }
            }
        }
        self.persist_streams().await;
    }

    pub async fn add_active_host(&self, stream_id: &str, connection_id: String, account_id: i64, audio_source: HostAudioSource) {
        {
            let mut streams = self.streams.lock().unwrap();
            if let Some(record) = streams.get_mut(stream_id) {
                record.active_hosts.push(ActiveHost { connection_id, account_id, audio_source });
            }
        }
        self.persist_streams().await;
    }

    pub async fn remove_active_host(&self, stream_id: &str, connection_id: &str, account_id: i64) {
        {
            let mut streams = self.streams.lock().unwrap();
            if let Some(record) = streams.get_mut(stream_id) {
                record.active_hosts.retain(|h| h.connection_id != connection_id);
                if !record.active_hosts.iter().any(|h| h.account_id == account_id) {
                    record.paused_host_account_ids.retain(|id| *id != account_id);
                }
            }
        }
        self.persist_streams().await;
    }

    // Sessions are encrypted at rest (AES-256-GCM) with a key generated on
    // first run and stored separately from the encrypted blob
    // (data/session-key.bin vs data/sessions.enc). That key is itself
    // protected via the OS-native secure store (DPAPI on Windows) before
    // being written to disk, tying decryption to this OS user account on
    // this machine - copying both files elsewhere isn't enough, unlike a
    // plain symmetric key sitting next to its ciphertext.
    async fn load_or_create_session_key(&self) -> Result<[u8; 32], String> {
        let mut guard = self.session_key.lock().await;
        if let Some(key) = *guard {
            return Ok(key);
        }

        let key_path = self.session_key_file();
        let key = match tokio::fs::read(&key_path).await {
            Ok(protected) => {
                let unprotected = secure_store::unprotect(&protected).await?;
                if unprotected.len() != 32 {
                    return Err("session key has unexpected length".into());
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(&unprotected);
                key
            }
            Err(_) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                let protected = secure_store::protect(&key).await?;
                tokio::fs::create_dir_all(&self.data_dir).await.map_err(|e| e.to_string())?;
                tokio::fs::write(&key_path, &protected).await.map_err(|e| e.to_string())?;
                key
            }
        };

        *guard = Some(key);
        Ok(key)
    }

    // Layout is iv(12) + authTag(16) + ciphertext - matching the Node
    // version's `Buffer.concat([iv, authTag, ciphertext])` byte-for-byte, so
    // this can read (and is read by) the exact same data/sessions.enc file
    // the Node API writes. RustCrypto's AEAD convention instead appends the
    // tag to the *end* of the ciphertext, so it has to be split off and
    // reordered on the way in and out.
    fn encrypt_sessions(key: &[u8; 32], plaintext: &str) -> String {
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = Nonce::from_slice(&iv);
        let ciphertext_with_tag = cipher.encrypt(nonce, plaintext.as_bytes()).expect("encryption failure");
        let (ciphertext, tag) = ciphertext_with_tag.split_at(ciphertext_with_tag.len() - 16);
        let mut out = Vec::with_capacity(12 + 16 + ciphertext.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(tag);
        out.extend_from_slice(ciphertext);
        STANDARD.encode(out)
    }

    fn decrypt_sessions(key: &[u8; 32], payload: &str) -> Result<String, String> {
        let data = STANDARD.decode(payload).map_err(|e| e.to_string())?;
        if data.len() < 28 {
            return Err("session payload too short".into());
        }
        let (iv, rest) = data.split_at(12);
        let (tag, ciphertext) = rest.split_at(16);
        let mut ciphertext_with_tag = Vec::with_capacity(ciphertext.len() + 16);
        ciphertext_with_tag.extend_from_slice(ciphertext);
        ciphertext_with_tag.extend_from_slice(tag);

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = Nonce::from_slice(iv);
        let plain = cipher.decrypt(nonce, ciphertext_with_tag.as_slice()).map_err(|_| "AES-GCM authentication failed".to_string())?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }

    async fn persist_sessions(&self) {
        let key = match self.load_or_create_session_key().await {
            Ok(key) => key,
            Err(err) => {
                eprintln!("Failed to persist sessions (key): {err}");
                return;
            }
        };
        let sessions: Vec<Session> = self.sessions.lock().unwrap().values().cloned().collect();
        let plaintext = match serde_json::to_string(&sessions) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("Failed to persist sessions (serialize): {err}");
                return;
            }
        };
        let encrypted = Self::encrypt_sessions(&key, &plaintext);
        if let Err(err) = tokio::fs::create_dir_all(&self.data_dir).await {
            eprintln!("Failed to persist sessions (mkdir): {err}");
            return;
        }
        if let Err(err) = tokio::fs::write(self.sessions_file(), encrypted).await {
            eprintln!("Failed to persist sessions (write): {err}");
        }
    }

    pub async fn load_sessions(&self) -> Result<(), String> {
        let key = self.load_or_create_session_key().await?;
        let path = self.sessions_file();
        let Ok(payload) = tokio::fs::read_to_string(&path).await else {
            return Ok(());
        };
        let plaintext = Self::decrypt_sessions(&key, payload.trim())?;
        let records: Vec<Session> = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;
        let mut sessions = self.sessions.lock().unwrap();
        for session in records {
            sessions.insert(session.token.clone(), session);
        }
        Ok(())
    }

    pub async fn create_session(&self, session: Session) {
        self.sessions.lock().unwrap().insert(session.token.clone(), session);
        self.persist_sessions().await;
    }

    pub fn get_session(&self, token: &str) -> Option<Session> {
        self.sessions.lock().unwrap().get(token).cloned()
    }

    pub async fn delete_session(&self, token: &str) {
        self.sessions.lock().unwrap().remove(token);
        self.persist_sessions().await;
    }

    async fn persist_account_settings(&self) {
        #[derive(serde::Serialize)]
        struct Entry {
            #[serde(rename = "accountId")]
            account_id: i64,
            #[serde(rename = "maxDeviceAmplitude")]
            max_device_amplitude: f64,
        }
        let entries: Vec<Entry> = self
            .account_settings
            .lock()
            .unwrap()
            .iter()
            .map(|(account_id, settings)| Entry { account_id: *account_id, max_device_amplitude: settings.max_device_amplitude })
            .collect();
        if let Err(err) = write_json(&self.data_dir, &self.account_settings_file(), &entries).await {
            eprintln!("Failed to persist account settings: {err}");
        }
    }

    pub async fn load_account_settings(&self) -> Result<(), String> {
        #[derive(serde::Deserialize)]
        struct Entry {
            #[serde(rename = "accountId")]
            account_id: i64,
            #[serde(rename = "maxDeviceAmplitude")]
            max_device_amplitude: f64,
        }
        let path = self.account_settings_file();
        let Ok(raw) = tokio::fs::read_to_string(&path).await else {
            return Ok(());
        };
        let entries: Vec<Entry> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let mut settings = self.account_settings.lock().unwrap();
        for entry in entries {
            settings.insert(entry.account_id, AccountSettings { max_device_amplitude: entry.max_device_amplitude });
        }
        Ok(())
    }

    pub fn get_account_settings(&self, account_id: i64) -> AccountSettings {
        self.account_settings
            .lock()
            .unwrap()
            .get(&account_id)
            .copied()
            .unwrap_or(AccountSettings { max_device_amplitude: DEFAULT_MAX_DEVICE_AMPLITUDE })
    }

    pub async fn set_account_settings(&self, account_id: i64, settings: AccountSettings) {
        self.account_settings.lock().unwrap().insert(account_id, settings);
        self.persist_account_settings().await;
    }
}

async fn write_json<T: serde::Serialize>(dir: &std::path::Path, path: &std::path::Path, value: &T) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    tokio::fs::write(path, json).await.map_err(|e| e.to_string())
}
