//! Outlook / Microsoft 365, through Microsoft Graph.

use chrono::{DateTime, SecondsFormat, Utc};
use futures::future::try_join_all;
use serde::Deserialize;
use serde_json::json;

use super::sort_page;
use super::types::*;

const API: &str = "https://graph.microsoft.com/v1.0";
const SELECT: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,isRead,flag,parentFolderId,hasAttachments,internetMessageId";

pub struct Outlook {
    http: reqwest::Client,
    token: String,
    account_id: String,
}

#[derive(Deserialize, Default)]
struct GraphAddress {
    name: Option<String>,
    address: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Recipient {
    #[serde(default)]
    email_address: GraphAddress,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GraphBody {
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Flag {
    #[serde(default)]
    flag_status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphMessage {
    id: String,
    conversation_id: Option<String>,
    subject: Option<String>,
    from: Option<Recipient>,
    #[serde(default)]
    to_recipients: Vec<Recipient>,
    #[serde(default)]
    cc_recipients: Vec<Recipient>,
    #[serde(default)]
    bcc_recipients: Vec<Recipient>,
    received_date_time: Option<DateTime<Utc>>,
    #[serde(default)]
    body_preview: String,
    #[serde(default)]
    body: GraphBody,
    #[serde(default)]
    is_read: bool,
    #[serde(default)]
    flag: Flag,
    #[serde(default)]
    parent_folder_id: String,
    internet_message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphFolder {
    id: String,
    display_name: String,
    #[serde(default)]
    unread_item_count: u64,
    #[serde(default)]
    total_item_count: u64,
    #[serde(default)]
    child_folder_count: u64,
}

#[derive(Deserialize)]
struct Page<T> {
    value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
    #[serde(rename = "@odata.count")]
    count: Option<u64>,
}

fn addr(r: &Recipient) -> EmailAddress {
    EmailAddress {
        name: r.email_address.name.clone().filter(|n| !n.is_empty()),
        email: r.email_address.address.clone().unwrap_or_else(|| "unknown".into()),
    }
}

/// An OData string literal.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn recipients(list: &str) -> Vec<serde_json::Value> {
    Compose::split(list).into_iter().map(|a| json!({ "emailAddress": { "address": super::parse_address(&a).email } })).collect()
}

impl Outlook {
    pub fn new(http: reqwest::Client, token: String, account_id: String) -> Self {
        Self { http, token, account_id }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, url: &str, query: &[(&str, String)]) -> Result<T, String> {
        let url = if url.starts_with("https://") { url.to_string() } else { format!("{API}{url}") };
        let res = self.http.get(url).bearer_auth(&self.token).query(query).send().await.map_err(|e| e.to_string())?;
        super::super::http_json(res).await
    }

    async fn send_json(&self, method: reqwest::Method, path: &str, body: serde_json::Value) -> Result<(), String> {
        let res = self.http.request(method, format!("{API}{path}")).bearer_auth(&self.token).json(&body).send().await.map_err(|e| e.to_string())?;
        super::super::http_ok(res).await
    }

    pub async fn folders(&self) -> Result<Vec<Folder>, String> {
        // The well-known folders, to tell which ids are the inbox, the trash, ….
        let mut well_known = Vec::new();
        for (name, kind) in [
            ("inbox", FolderType::Inbox),
            ("sentitems", FolderType::Sent),
            ("deleteditems", FolderType::Trash),
            ("junkemail", FolderType::Spam),
            ("archive", FolderType::All),
            ("drafts", FolderType::Drafts),
        ] {
            if let Ok(f) = self.get::<GraphFolder>(&format!("/me/mailFolders/{name}"), &[("$select", "id".into())]).await {
                well_known.push((f.id, kind));
            }
        }

        let mut result = Vec::new();
        // Breadth-first through the folder tree.
        let mut pending: Vec<(String, Option<String>)> = vec![("/me/mailFolders".into(), None)];
        while let Some((url, parent)) = pending.pop() {
            let mut next = Some(url);
            let mut first = true;
            while let Some(url) = next.take() {
                let query = if first { vec![("$top", "100".to_string())] } else { vec![] };
                first = false;
                let page: Page<GraphFolder> = self.get(&url, &query).await?;
                for f in page.value {
                    if f.child_folder_count > 0 {
                        pending.push((format!("/me/mailFolders/{}/childFolders", f.id), Some(f.id.clone())));
                    }
                    let folder_type = well_known.iter().find(|(id, _)| *id == f.id).map(|(_, k)| *k).unwrap_or(FolderType::Custom);
                    result.push(Folder {
                        id: f.id,
                        name: f.display_name,
                        folder_type,
                        provider: Provider::Outlook,
                        account_id: self.account_id.clone(),
                        unread_count: Some(f.unread_item_count),
                        total_count: Some(f.total_item_count),
                        parent_id: parent.clone(),
                    });
                }
                next = page.next_link;
            }
        }
        Ok(result)
    }

    pub async fn emails(&self, query: &EmailQuery) -> Result<EmailPage, String> {
        let s = &query.search;
        let size = query.page_size.clamp(1, 1000);
        let iso = |d: DateTime<Utc>| d.to_rfc3339_opts(SecondsFormat::Secs, true);

        let mut filters = Vec::new();
        if let Some(v) = s.from_text() {
            filters.push(format!("from/emailAddress/address eq {}", lit(v)));
        }
        if let Some(v) = s.to_text() {
            let v = lit(v);
            filters.push(format!(
                "(toRecipients/any(r:r/emailAddress/address eq {v}) or ccRecipients/any(r:r/emailAddress/address eq {v}) or bccRecipients/any(r:r/emailAddress/address eq {v}))"
            ));
        }
        if let Some(v) = s.subject_text() {
            filters.push(format!("contains(subject,{})", lit(v)));
        }
        let (after, before) = (s.after.map(iso), s.before.map(iso));

        let mut params: Vec<(&str, String)> = vec![("$top", size.to_string()), ("$select", SELECT.into())];
        let mut sort_locally = false;
        if let Some(text) = s.body_text() {
            // A body search is a $search, which Graph can't combine with $filter, $orderby or $skip:
            // it returns the best matches, newest first, and the rest of the criteria apply to those.
            params.push(("$search", format!("\"body:{}\"", text.replace('"', " "))));
            sort_locally = true;
        } else {
            // Graph wants every $orderby property to lead the $filter (else "InefficientFilter"),
            // so a date sort starts the filter with the date range.
            let mut all = vec![format!("receivedDateTime ge {}", after.clone().unwrap_or_else(|| "1900-01-01T00:00:00Z".into()))];
            if let Some(b) = &before {
                all.push(format!("receivedDateTime le {b}"));
            }
            all.extend(filters.iter().cloned());
            params.push(("$skip", ((query.page.max(1) - 1) * size).to_string()));
            params.push(("$count", "true".into()));
            if query.sort.field == SortField::Date || filters.is_empty() && after.is_none() && before.is_none() {
                let field = match query.sort.field {
                    SortField::Date => "receivedDateTime",
                    SortField::From => "from/emailAddress/address",
                    SortField::To => "toRecipients/emailAddress/address",
                };
                let dir = if query.sort.direction == SortDirection::Asc { "asc" } else { "desc" };
                params.push(("$orderby", format!("{field} {dir}")));
                if query.sort.field == SortField::Date {
                    params.push(("$filter", all.join(" and ")));
                }
            } else {
                // Filtering and sorting by an address: let the server filter (by date), sort the page here.
                params.push(("$orderby", "receivedDateTime desc".into()));
                params.push(("$filter", all.join(" and ")));
                sort_locally = true;
            }
        }

        let page: Page<GraphMessage> = self.get(&format!("/me/mailFolders/{}/messages", query.folder_id), &params).await?;
        let mut emails: Vec<Email> = page.value.into_iter().map(|m| self.to_email(m)).collect();
        if s.body_text().is_some() {
            // The other criteria, applied to what $search returned.
            let has = |list: &[EmailAddress], v: &str| list.iter().any(|a| a.email.eq_ignore_ascii_case(v));
            emails.retain(|e| {
                s.from_text().is_none_or(|v| e.from.email.eq_ignore_ascii_case(v))
                    && s.to_text().is_none_or(|v| has(&e.to, v) || has(&e.cc, v) || has(&e.bcc, v))
                    && s.subject_text().is_none_or(|v| e.subject.to_lowercase().contains(&v.to_lowercase()))
                    && s.after.is_none_or(|d| e.date >= d)
                    && s.before.is_none_or(|d| e.date <= d)
            });
        }
        if sort_locally {
            sort_page(&mut emails, query.sort);
        }
        let total = page.count.unwrap_or(emails.len() as u64);
        Ok(EmailPage { emails, total_count: total })
    }

    fn to_email(&self, m: GraphMessage) -> Email {
        let html = m.body.content_type.eq_ignore_ascii_case("html");
        Email {
            id: m.id,
            thread_id: m.conversation_id,
            provider: Provider::Outlook,
            account_id: self.account_id.clone(),
            subject: m.subject.unwrap_or_default(),
            from: m.from.as_ref().map(addr).unwrap_or_else(|| EmailAddress { name: None, email: "unknown".into() }),
            to: m.to_recipients.iter().map(addr).collect(),
            cc: m.cc_recipients.iter().map(addr).collect(),
            bcc: m.bcc_recipients.iter().map(addr).collect(),
            date: m.received_date_time.unwrap_or_else(Utc::now),
            snippet: m.body_preview,
            body: if html { String::new() } else { m.body.content.clone() },
            body_html: html.then_some(m.body.content),
            is_read: m.is_read,
            is_starred: m.flag.flag_status == "flagged",
            labels: vec![],
            folder_id: m.parent_folder_id,
            attachments: vec![],
            message_id: m.internet_message_id,
            in_reply_to: None,
            references: None,
        }
    }

    pub async fn send(&self, compose: &Compose) -> Result<(), String> {
        let message = json!({
            "subject": compose.subject,
            "body": { "contentType": "Text", "content": compose.body },
            "toRecipients": recipients(&compose.to),
            "ccRecipients": recipients(&compose.cc),
            "bccRecipients": recipients(&compose.bcc),
        });
        if message["toRecipients"].as_array().is_none_or(|a| a.is_empty()) {
            return Err("Add at least one recipient.".into());
        }
        // sendMail can't set In-Reply-To/References (Graph only takes X- headers); Outlook threads its
        // own conversations by subject, which the "Re:" keeps.
        self.send_json(reqwest::Method::POST, "/me/sendMail", json!({ "message": message, "saveToSentItems": true })).await
    }

    pub async fn mark_read(&self, id: &str) -> Result<(), String> {
        self.send_json(reqwest::Method::PATCH, &format!("/me/messages/{id}"), json!({ "isRead": true })).await
    }

    pub async fn move_to(&self, ids: &[String], folder_id: &str) -> Result<(), String> {
        for chunk in ids.chunks(4) {
            try_join_all(chunk.iter().map(|id| async move {
                self.send_json(reqwest::Method::POST, &format!("/me/messages/{id}/move"), json!({ "destinationId": folder_id })).await
            }))
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odata_literals_escape_quotes() {
        assert_eq!(lit("O'Brien"), "'O''Brien'");
    }
}
