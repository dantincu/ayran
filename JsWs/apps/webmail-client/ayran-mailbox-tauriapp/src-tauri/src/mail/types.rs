//! The shapes the frontend sees (`src/types/email.ts`, `src/types/folder.ts`), shared by every provider.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gmail,
    Outlook,
    Yahoo,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Gmail => "gmail",
            Provider::Outlook => "outlook",
            Provider::Yahoo => "yahoo",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EmailAddress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Email {
    pub id: String,
    pub thread_id: Option<String>,
    pub provider: Provider,
    pub account_id: String,
    pub subject: String,
    pub from: EmailAddress,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    pub date: DateTime<Utc>,
    pub snippet: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    pub is_read: bool,
    pub is_starred: bool,
    pub labels: Vec<String>,
    pub folder_id: String,
    pub attachments: Vec<Attachment>,
    /// The message's own `Message-ID` (what a reply's In-Reply-To / References point at).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
}

/// What opening a message adds to its list entry (the frontend's `Partial<Email>`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFull {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderType {
    Inbox,
    Sent,
    All,
    Trash,
    Spam,
    Drafts,
    Custom,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub folder_type: FolderType,
    pub provider: Provider,
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchParams {
    pub subject: Option<String>,
    pub subject_is_regex: bool,
    pub body: Option<String>,
    pub body_is_regex: bool,
    pub from: Option<String>,
    /// Matches To, Cc or Bcc.
    pub to: Option<String>,
    pub after: Option<DateTime<Utc>>,
    pub before: Option<DateTime<Utc>>,
}

impl SearchParams {
    fn text(value: &Option<String>, is_regex: bool) -> Option<&str> {
        value.as_deref().map(str::trim).filter(|v| !v.is_empty() && !is_regex)
    }
    /// The subject to search for on the server (a regex is matched locally instead, see `regex_filter`).
    pub fn subject_text(&self) -> Option<&str> {
        Self::text(&self.subject, self.subject_is_regex)
    }
    pub fn body_text(&self) -> Option<&str> {
        Self::text(&self.body, self.body_is_regex)
    }
    pub fn from_text(&self) -> Option<&str> {
        self.from.as_deref().map(str::trim).filter(|v| !v.is_empty())
    }
    pub fn to_text(&self) -> Option<&str> {
        self.to.as_deref().map(str::trim).filter(|v| !v.is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortField {
    #[default]
    Date,
    From,
    To,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct SortParams {
    pub field: SortField,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailQuery {
    pub folder_id: String,
    #[serde(default = "one")]
    pub page: u32,
    #[serde(default = "fifty")]
    pub page_size: u32,
    #[serde(default)]
    pub search: SearchParams,
    #[serde(default)]
    pub sort: SortParams,
}

fn one() -> u32 {
    1
}
fn fifty() -> u32 {
    50
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailPage {
    pub emails: Vec<Email>,
    pub total_count: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Compose {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub thread_id: Option<String>,
}

impl Compose {
    pub fn split(list: &str) -> Vec<String> {
        list.split([',', ';']).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
    }
}
