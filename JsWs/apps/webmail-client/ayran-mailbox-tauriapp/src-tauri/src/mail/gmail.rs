//! Gmail, through the Gmail REST API (labels are its folders).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, TimeZone, Utc};
use futures::stream::{self, StreamExt, TryStreamExt};
use lettre::message::Mailbox;
use serde::Deserialize;
use serde_json::json;

use super::types::*;
use super::{build_message, parse_address, parse_address_list, sort_page};

const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const METADATA_HEADERS: &[&str] = &["From", "To", "Cc", "Bcc", "Subject", "Date", "In-Reply-To", "References", "Message-ID"];

/// Gmail pages by token, not by number: the token that starts each page of a listing we've already
/// walked through is remembered, so page N doesn't cost N requests every time.
/// Key: account, label, query, page size → tokens for pages 2, 3, ….
static PAGE_TOKENS: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(Default::default);

pub struct Gmail {
    http: reqwest::Client,
    token: String,
    account_id: String,
}

#[derive(Deserialize)]
struct Header {
    name: String,
    value: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Body {
    data: Option<String>,
    #[serde(default)]
    size: u64,
    attachment_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    #[serde(default)]
    mime_type: String,
    #[serde(default)]
    headers: Vec<Header>,
    #[serde(default)]
    body: Body,
    #[serde(default)]
    parts: Vec<Part>,
    #[serde(default)]
    filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Msg {
    id: String,
    thread_id: String,
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    snippet: String,
    payload: Part,
    internal_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Label {
    id: String,
    name: String,
    messages_unread: Option<u64>,
    messages_total: Option<u64>,
}

fn header<'a>(headers: &'a [Header], name: &str) -> &'a str {
    headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| h.value.as_str()).unwrap_or("")
}

fn decode(data: &str) -> String {
    let bytes = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).or_else(|_| URL_SAFE.decode(data)).unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The first text/plain and text/html parts, outside attachments.
fn bodies(part: &Part, text: &mut Option<String>, html: &mut Option<String>) {
    if part.filename.is_empty() {
        if let Some(data) = &part.body.data {
            match part.mime_type.as_str() {
                "text/plain" if text.is_none() => *text = Some(decode(data)),
                "text/html" if html.is_none() => *html = Some(decode(data)),
                _ => {}
            }
        }
    }
    for p in &part.parts {
        bodies(p, text, html);
    }
}

fn attachments(part: &Part, out: &mut Vec<Attachment>) {
    if let (false, Some(id)) = (part.filename.is_empty(), &part.body.attachment_id) {
        out.push(Attachment { id: id.clone(), filename: part.filename.clone(), mime_type: part.mime_type.clone(), size: part.body.size });
    }
    for p in &part.parts {
        attachments(p, out);
    }
}

fn references(headers: &[Header]) -> Option<Vec<String>> {
    let refs: Vec<String> = header(headers, "References").split_whitespace().map(String::from).collect();
    (!refs.is_empty()).then_some(refs)
}

fn non_empty(s: &str) -> Option<String> {
    (!s.trim().is_empty()).then(|| s.trim().to_string())
}

fn parse_date(raw: &str, internal: Option<&str>) -> DateTime<Utc> {
    DateTime::parse_from_rfc2822(raw.trim())
        .map(|d| d.with_timezone(&Utc))
        // Some senders write "(UTC)" or similar after the date.
        .or_else(|_| DateTime::parse_from_rfc2822(raw.split(" (").next().unwrap_or(raw).trim()).map(|d| d.with_timezone(&Utc)))
        .ok()
        .or_else(|| internal.and_then(|ms| ms.parse::<i64>().ok()).and_then(|ms| Utc.timestamp_millis_opt(ms).single()))
        .unwrap_or_else(Utc::now)
}

impl Gmail {
    pub fn new(http: reqwest::Client, token: String, account_id: String) -> Self {
        Self { http, token, account_id }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str, query: &[(&str, String)]) -> Result<T, String> {
        let res = self.http.get(format!("{API}{path}")).bearer_auth(&self.token).query(query).send().await.map_err(|e| e.to_string())?;
        super::super::http_json(res).await
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> Result<(), String> {
        let res = self.http.post(format!("{API}{path}")).bearer_auth(&self.token).json(&body).send().await.map_err(|e| e.to_string())?;
        super::super::http_ok(res).await
    }

    pub async fn folders(&self) -> Result<Vec<Folder>, String> {
        #[derive(Deserialize)]
        struct Labels {
            #[serde(default)]
            labels: Vec<Label>,
        }
        let labels = self.get::<Labels>("/labels", &[]).await?.labels;

        // The list doesn't carry counts; each label's own resource does.
        // (Futures collected first: rustc can't prove a lazily-mapped stream's futures `Send`.)
        let requests: Vec<_> = labels
            .into_iter()
            .map(|l| Box::pin(async move { self.get::<Label>(&format!("/labels/{}", l.id), &[]).await.unwrap_or(l) }))
            .collect();
        let detailed: Vec<Label> = stream::iter(requests).buffered(5).collect().await;

        let by_name: HashMap<&str, &str> = detailed.iter().map(|l| (l.name.as_str(), l.id.as_str())).collect();
        let mut folders: Vec<Folder> = detailed
            .iter()
            // Gmail's chat/draft/system-only labels don't belong in a mail folder tree.
            .filter(|l| !matches!(l.id.as_str(), "CHAT" | "DRAFT" | "UNREAD"))
            .map(|l| {
                let (folder_type, display) = match l.id.as_str() {
                    "INBOX" => (FolderType::Inbox, "Inbox"),
                    "SENT" => (FolderType::Sent, "Sent"),
                    "SPAM" => (FolderType::Spam, "Spam"),
                    "TRASH" => (FolderType::Trash, "Trash"),
                    "STARRED" => (FolderType::Custom, "Starred"),
                    "IMPORTANT" => (FolderType::Custom, "Important"),
                    "CATEGORY_PERSONAL" => (FolderType::Custom, "Personal"),
                    "CATEGORY_SOCIAL" => (FolderType::Custom, "Social"),
                    "CATEGORY_PROMOTIONS" => (FolderType::Custom, "Promotions"),
                    "CATEGORY_UPDATES" => (FolderType::Custom, "Updates"),
                    "CATEGORY_FORUMS" => (FolderType::Custom, "Forums"),
                    _ => (FolderType::Custom, l.name.rsplit('/').next().unwrap_or(&l.name)),
                };
                let parent_id = l.name.rfind('/').and_then(|i| by_name.get(&l.name[..i])).map(|id| id.to_string());
                Folder {
                    id: l.id.clone(),
                    name: display.to_string(),
                    folder_type,
                    provider: Provider::Gmail,
                    account_id: self.account_id.clone(),
                    unread_count: l.messages_unread,
                    total_count: l.messages_total,
                    parent_id,
                }
            })
            .collect();

        // "All Mail" isn't a label: it's a listing without one.
        folders.push(Folder {
            id: "ALLMAIL".into(),
            name: "All Mail".into(),
            folder_type: FolderType::All,
            provider: Provider::Gmail,
            account_id: self.account_id.clone(),
            unread_count: None,
            total_count: None,
            parent_id: None,
        });
        Ok(folders)
    }

    fn search_query(search: &SearchParams) -> String {
        let quote = |s: &str| format!("\"{}\"", s.replace('"', " "));
        let mut q = Vec::new();
        if let Some(v) = search.from_text() {
            q.push(format!("from:{}", quote(v)));
        }
        if let Some(v) = search.to_text() {
            let v = quote(v);
            q.push(format!("{{to:{v} cc:{v} bcc:{v}}}"));
        }
        if let Some(v) = search.subject_text() {
            q.push(format!("subject:({})", quote(v)));
        }
        if let Some(v) = search.body_text() {
            q.push(quote(v));
        }
        if let Some(d) = search.after {
            q.push(format!("after:{}", d.timestamp()));
        }
        if let Some(d) = search.before {
            q.push(format!("before:{}", d.timestamp()));
        }
        q.join(" ")
    }

    pub async fn emails(&self, query: &EmailQuery) -> Result<EmailPage, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct List {
            #[serde(default)]
            messages: Vec<IdOnly>,
            #[serde(default)]
            result_size_estimate: u64,
            next_page_token: Option<String>,
        }
        #[derive(Deserialize)]
        struct IdOnly {
            id: String,
        }

        let q = Self::search_query(&query.search);
        let label = (query.folder_id != "ALLMAIL").then(|| query.folder_id.clone());
        let page = query.page.max(1) as usize;
        let size = query.page_size.clamp(1, 500);
        let cache_key = format!("{}\u{0}{}\u{0}{q}\u{0}{size}", self.account_id, label.as_deref().unwrap_or(""));

        let list_params = |token: Option<&str>| {
            let mut p = vec![("maxResults", size.to_string())];
            if !q.is_empty() {
                p.push(("q", q.clone()));
            }
            if let Some(l) = &label {
                p.push(("labelIds", l.clone()));
            }
            if let Some(t) = token {
                p.push(("pageToken", t.to_string()));
            }
            p
        };

        // The token that starts the requested page: from the cache, walking forward from what's known.
        let mut tokens = PAGE_TOKENS.lock().unwrap().get(&cache_key).cloned().unwrap_or_default();
        if page == 1 {
            tokens.clear(); // the first page is a fresh look at the mailbox
        }
        while tokens.len() < page - 1 {
            let mut p = list_params(tokens.last().map(String::as_str));
            p.push(("fields", "nextPageToken".into()));
            match self.get::<List>("/messages", &p).await?.next_page_token {
                Some(t) => tokens.push(t),
                None => return Ok(EmailPage { emails: vec![], total_count: 0 }),
            }
        }
        let list = self.get::<List>("/messages", &list_params(page.checked_sub(2).map(|i| tokens[i].as_str()))).await?;
        if let Some(next) = &list.next_page_token {
            tokens.truncate(page - 1);
            tokens.push(next.clone());
        }
        PAGE_TOKENS.lock().unwrap().insert(cache_key, tokens);

        // resultSizeEstimate is unreliable for big folders; without a search the real count is known.
        let mut total = list.result_size_estimate;
        if q.is_empty() {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Profile {
                messages_total: Option<u64>,
            }
            let real = match &label {
                None => self.get::<Profile>("/profile", &[]).await.ok().and_then(|p| p.messages_total),
                Some(l) => self.get::<Label>(&format!("/labels/{l}"), &[]).await.ok().and_then(|l| l.messages_total),
            };
            total = real.unwrap_or(total);
        }

        let mut meta_query: Vec<(&str, String)> = vec![("format", "metadata".into())];
        meta_query.extend(METADATA_HEADERS.iter().map(|h| ("metadataHeaders", h.to_string())));
        let meta_query = &meta_query;
        let requests: Vec<_> = list
            .messages
            .iter()
            .map(|m| Box::pin(async move { self.get::<Msg>(&format!("/messages/{}", m.id), meta_query).await.map(|msg| self.to_email(msg)) }))
            .collect();
        let mut emails: Vec<Email> = stream::iter(requests).buffered(5).try_collect().await?;

        if query.sort.field != SortField::Date || query.sort.direction == SortDirection::Asc {
            sort_page(&mut emails, query.sort);
        }
        Ok(EmailPage { emails, total_count: total })
    }

    fn to_email(&self, msg: Msg) -> Email {
        let h = &msg.payload.headers;
        let (mut text, mut html) = (None, None);
        bodies(&msg.payload, &mut text, &mut html);
        let mut atts = Vec::new();
        attachments(&msg.payload, &mut atts);
        let folder_id = if msg.label_ids.iter().any(|l| l == "INBOX") {
            "INBOX".to_string()
        } else {
            msg.label_ids.first().cloned().unwrap_or_else(|| "ALLMAIL".into())
        };
        Email {
            id: msg.id,
            thread_id: Some(msg.thread_id),
            provider: Provider::Gmail,
            account_id: self.account_id.clone(),
            subject: header(h, "Subject").to_string(),
            from: parse_address(header(h, "From")),
            to: parse_address_list(header(h, "To")),
            cc: parse_address_list(header(h, "Cc")),
            bcc: parse_address_list(header(h, "Bcc")),
            date: parse_date(header(h, "Date"), msg.internal_date.as_deref()),
            snippet: msg.snippet,
            body: text.unwrap_or_default(),
            body_html: html,
            is_read: !msg.label_ids.iter().any(|l| l == "UNREAD"),
            is_starred: msg.label_ids.iter().any(|l| l == "STARRED"),
            folder_id,
            labels: msg.label_ids,
            attachments: atts,
            message_id: non_empty(header(h, "Message-ID")),
            in_reply_to: non_empty(header(h, "In-Reply-To")),
            references: references(h),
        }
    }

    pub async fn email_full(&self, id: &str) -> Result<EmailFull, String> {
        let msg: Msg = self.get(&format!("/messages/{id}"), &[("format", "full".into())]).await?;
        let (mut text, mut html) = (None, None);
        bodies(&msg.payload, &mut text, &mut html);
        let mut atts = Vec::new();
        attachments(&msg.payload, &mut atts);
        let h = &msg.payload.headers;
        Ok(EmailFull {
            body: Some(text.unwrap_or_default()),
            body_html: html,
            attachments: Some(atts),
            message_id: non_empty(header(h, "Message-ID")),
            in_reply_to: non_empty(header(h, "In-Reply-To")),
            references: references(h),
        })
    }

    pub async fn send(&self, compose: &Compose, from: &Mailbox) -> Result<(), String> {
        let raw = URL_SAFE_NO_PAD.encode(build_message(compose, from)?.formatted());
        let mut body = json!({ "raw": raw });
        if let Some(t) = compose.thread_id.as_deref().filter(|t| !t.is_empty()) {
            body["threadId"] = json!(t);
        }
        self.post("/messages/send", body).await
    }

    pub async fn modify_labels(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<(), String> {
        // batchModify takes up to 1000 ids.
        for chunk in ids.chunks(1000) {
            self.post("/messages/batchModify", json!({ "ids": chunk, "addLabelIds": add, "removeLabelIds": remove })).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_query_quotes_values_and_covers_cc_and_bcc() {
        let search = SearchParams {
            from: Some("bob@x.org".into()),
            to: Some("me".into()),
            subject: Some("say \"hi\"".into()),
            body: Some("/regex/".into()),
            body_is_regex: true,
            ..Default::default()
        };
        assert_eq!(Gmail::search_query(&search), r#"from:"bob@x.org" {to:"me" cc:"me" bcc:"me"} subject:("say  hi ")"#);
    }

    #[test]
    fn dates_fall_back_to_the_internal_date() {
        assert_eq!(parse_date("Tue, 1 Jul 2025 10:00:00 +0200 (CEST)", None).to_rfc3339(), "2025-07-01T08:00:00+00:00");
        assert_eq!(parse_date("garbage", Some("1700000000000")).timestamp(), 1_700_000_000);
    }
}
