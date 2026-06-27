use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilenAccount {
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    pub account: FilenAccount,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostAudioSource {
    Microphone,
    System,
    TestTone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveHost {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "accountId")]
    pub account_id: i64,
    #[serde(rename = "audioSource")]
    pub audio_source: HostAudioSource,
}

/// "merged": any number of hosts can stream into it at once, mixed together.
/// "simple": exactly one host streams at a time, forwarded directly (no
/// mixing, but still subject to the account's volume cap) - a second host
/// starting up immediately supersedes whichever one was previously streaming
/// on it.
/// "raw": same single-active-host/superseding behavior as "simple", but
/// completely unprocessed - no volume cap, no limiter, bytes forwarded
/// exactly as received.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamMode {
    Merged,
    Simple,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamRecord {
    pub id: String,
    pub name: String,
    pub mode: StreamMode,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// currently connected host connections feeding audio into this stream
    #[serde(rename = "activeHosts")]
    pub active_hosts: Vec<ActiveHost>,
    /// accountId -> paused flag, for hosts that joined but paused streaming
    #[serde(rename = "pausedHostAccountIds")]
    pub paused_host_account_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AccountSettings {
    /// fraction of full-scale 16-bit PCM a single device stream's peak
    /// amplitude is limited to before mixing
    #[serde(rename = "maxDeviceAmplitude")]
    pub max_device_amplitude: f64,
}
