//! Yahoo Mail, over IMAP (reading, moving) and SMTP (sending), signed in with an app password.
//!
//! A message's id is `<mailbox>::<uid>`. Each call opens its own IMAP session (Yahoo drops idle
//! ones quickly), so nothing needs keeping alive between commands.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_imap::imap_proto::NameAttribute;
use async_imap::types::Flag;
use chrono::{TimeZone, Utc};
use futures::TryStreamExt;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use mail_parser::{MessageParser, MimeHeaders};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use super::types::*;
use super::{addresses, build_message, sort_page};

const IMAP_HOST: &str = "imap.mail.yahoo.com";
const IMAP_PORT: u16 = 993;
const SMTP_HOST: &str = "smtp.mail.yahoo.com";
const HEADER_FIELDS: &str = "FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES";

type Session = async_imap::Session<TlsStream<TcpStream>>;

pub struct Yahoo {
    email: String,
    app_password: String,
    account_id: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// An IMAP quoted string.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The IMAP SEARCH criteria for a search (the regex parts are matched afterwards, see `regex_filter`).
fn search_criteria(s: &SearchParams) -> String {
    let mut c = Vec::new();
    if let Some(v) = s.from_text() {
        c.push(format!("FROM {}", quote(v)));
    }
    if let Some(v) = s.to_text() {
        let v = quote(v);
        c.push(format!("OR OR TO {v} CC {v} BCC {v}"));
    }
    if let Some(v) = s.subject_text() {
        c.push(format!("SUBJECT {}", quote(v)));
    }
    if let Some(v) = s.body_text() {
        c.push(format!("BODY {}", quote(v)));
    }
    // IMAP dates have no time: SINCE is inclusive of the day, BEFORE exclusive.
    if let Some(d) = s.after {
        c.push(format!("SINCE {}", d.format("%-d-%b-%Y")));
    }
    if let Some(d) = s.before {
        c.push(format!("BEFORE {}", (d + chrono::Duration::days(1)).format("%-d-%b-%Y")));
    }
    if c.is_empty() {
        "ALL".into()
    } else {
        c.join(" ")
    }
}

fn parse_id(id: &str) -> Result<(&str, u32), String> {
    let (mailbox, uid) = id.rsplit_once("::").ok_or("Not a Yahoo message id")?;
    Ok((mailbox, uid.parse().map_err(|_| "Not a Yahoo message id")?))
}

fn by_mailbox(ids: &[String]) -> Result<BTreeMap<&str, Vec<u32>>, String> {
    let mut map: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    for id in ids {
        let (mailbox, uid) = parse_id(id)?;
        map.entry(mailbox).or_default().push(uid);
    }
    Ok(map)
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

fn folder_type(name: &str, attributes: &[NameAttribute]) -> FolderType {
    for a in attributes {
        match a {
            NameAttribute::Sent => return FolderType::Sent,
            NameAttribute::Trash => return FolderType::Trash,
            NameAttribute::Junk => return FolderType::Spam,
            NameAttribute::Drafts => return FolderType::Drafts,
            NameAttribute::All | NameAttribute::Archive => return FolderType::All,
            _ => {}
        }
    }
    match name.to_ascii_lowercase().as_str() {
        "inbox" => FolderType::Inbox,
        "sent" | "sent messages" => FolderType::Sent,
        "trash" | "deleted messages" => FolderType::Trash,
        "bulk mail" | "bulk" | "junk" | "spam" => FolderType::Spam,
        "draft" | "drafts" => FolderType::Drafts,
        "archive" => FolderType::All,
        _ => FolderType::Custom,
    }
}

impl Yahoo {
    pub fn new(email: String, app_password: String, account_id: String) -> Self {
        Self { email, app_password, account_id }
    }

    async fn connect(&self) -> Result<Session, String> {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        let tcp = TcpStream::connect((IMAP_HOST, IMAP_PORT)).await.map_err(err)?;
        let tls = TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from(IMAP_HOST).map_err(err)?, tcp)
            .await
            .map_err(err)?;
        let mut client = async_imap::Client::new(tls);
        client.read_response().await.map_err(err)?.ok_or("The IMAP server closed the connection")?;
        client.login(&self.email, &self.app_password).await.map_err(|(e, _)| err(e))
    }

    /// Runs `f` in a fresh session and logs out after.
    async fn with<T>(&self, f: impl AsyncFnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut session = self.connect().await?;
        let result = f(&mut session).await;
        let _ = session.logout().await;
        result
    }

    pub async fn verify(&self) -> Result<(), String> {
        self.with(async |_| Ok(())).await
    }

    async fn list_folders(&self, session: &mut Session) -> Result<Vec<Folder>, String> {
        let names: Vec<_> = session.list(Some(""), Some("*")).await.map_err(err)?.try_collect().await.map_err(err)?;
        let mut folders = Vec::new();
        for n in &names {
            if n.attributes().iter().any(|a| matches!(a, NameAttribute::NoSelect)) {
                continue;
            }
            let path = n.name().to_string();
            let (parent_id, leaf) = match n.delimiter().and_then(|d| path.rsplit_once(d)) {
                Some((parent, leaf)) => (Some(parent.to_string()), leaf.to_string()),
                None => (None, path.clone()),
            };
            let folder_type = folder_type(&leaf, n.attributes());
            folders.push(Folder {
                name: if folder_type == FolderType::Inbox { "Inbox".into() } else { leaf },
                id: path,
                folder_type,
                provider: Provider::Yahoo,
                account_id: self.account_id.clone(),
                unread_count: None,
                total_count: None,
                parent_id,
            });
        }
        Ok(folders)
    }

    pub async fn folders(&self) -> Result<Vec<Folder>, String> {
        self.with(async |s| {
            let mut folders = self.list_folders(s).await?;
            for f in &mut folders {
                // Some special folders refuse STATUS; they simply show no counts.
                if let Ok(status) = s.status(&f.id, "(MESSAGES UNSEEN)").await {
                    f.total_count = Some(status.exists.into());
                    f.unread_count = status.unseen.map(Into::into);
                }
            }
            Ok(folders)
        })
        .await
    }

    /// The account's folder of a kind (the trash, the archive), by its special-use flag or name.
    async fn special_folder(&self, s: &mut Session, kind: FolderType) -> Result<String, String> {
        self.list_folders(s)
            .await?
            .into_iter()
            .find(|f| f.folder_type == kind)
            .map(|f| f.id)
            .ok_or_else(|| {
                let name = if kind == FolderType::Trash { "Trash" } else { "Archive" };
                format!("This Yahoo account has no {name} folder.")
            })
    }

    pub async fn emails(&self, query: &EmailQuery) -> Result<EmailPage, String> {
        self.with(async |s| {
            s.examine(&query.folder_id).await.map_err(err)?;
            let mut uids: Vec<u32> = s.uid_search(search_criteria(&query.search)).await.map_err(err)?.into_iter().collect();
            // UIDs grow with arrival, so their order is the date order the server can give us.
            uids.sort_unstable();
            if query.sort.direction == SortDirection::Desc {
                uids.reverse();
            }
            let total = uids.len() as u64;
            let size = query.page_size.max(1) as usize;
            let start = (query.page.max(1) as usize - 1) * size;
            let page: Vec<u32> = uids.into_iter().skip(start).take(size).collect();
            if page.is_empty() {
                return Ok(EmailPage { emails: vec![], total_count: total });
            }

            let fetched: Vec<_> = s
                .uid_fetch(uid_set(&page), format!("(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])"))
                .await
                .map_err(err)?
                .try_collect()
                .await
                .map_err(err)?;

            let mut emails = Vec::with_capacity(fetched.len());
            for f in &fetched {
                let Some(uid) = f.uid else { continue };
                let header = f.header().unwrap_or_default();
                let msg = MessageParser::default().parse(header);
                let flags: Vec<Flag> = f.flags().collect();
                let id = format!("{}::{uid}", query.folder_id);
                let date = msg
                    .as_ref()
                    .and_then(|m| m.date())
                    .and_then(|d| Utc.timestamp_opt(d.to_timestamp(), 0).single())
                    .or_else(|| f.internal_date().map(|d| d.with_timezone(&Utc)))
                    .unwrap_or_else(Utc::now);
                emails.push(Email {
                    thread_id: Some(id.clone()),
                    id,
                    provider: Provider::Yahoo,
                    account_id: self.account_id.clone(),
                    subject: msg.as_ref().and_then(|m| m.subject()).unwrap_or("(no subject)").to_string(),
                    from: msg.as_ref().map(|m| addresses(m.from())).and_then(|a| a.into_iter().next()).unwrap_or(EmailAddress {
                        name: None,
                        email: "unknown".into(),
                    }),
                    to: msg.as_ref().map(|m| addresses(m.to())).unwrap_or_default(),
                    cc: msg.as_ref().map(|m| addresses(m.cc())).unwrap_or_default(),
                    bcc: msg.as_ref().map(|m| addresses(m.bcc())).unwrap_or_default(),
                    date,
                    snippet: String::new(),
                    body: String::new(),
                    body_html: None,
                    is_read: flags.iter().any(|f| matches!(f, Flag::Seen)),
                    is_starred: flags.iter().any(|f| matches!(f, Flag::Flagged)),
                    labels: vec![],
                    folder_id: query.folder_id.clone(),
                    attachments: vec![],
                    message_id: msg.as_ref().and_then(|m| m.message_id()).map(|id| format!("<{id}>")),
                    in_reply_to: msg.as_ref().and_then(|m| m.in_reply_to().as_text().map(|id| format!("<{id}>"))),
                    references: msg.as_ref().and_then(|m| {
                        let refs = m.references();
                        refs.as_text_list()
                            .map(|l| l.iter().map(|r| format!("<{r}>")).collect::<Vec<_>>())
                            .or_else(|| refs.as_text().map(|r| vec![format!("<{r}>")]))
                    }),
                });
            }
            // The server returned them in its own order; restore the page's.
            if query.sort.field == SortField::Date {
                emails.sort_by_key(|e| page.iter().position(|u| e.id.ends_with(&format!("::{u}"))));
            } else {
                sort_page(&mut emails, query.sort);
            }
            Ok(EmailPage { emails, total_count: total })
        })
        .await
    }

    pub async fn email_full(&self, id: &str) -> Result<EmailFull, String> {
        let (mailbox, uid) = parse_id(id)?;
        self.with(async |s| {
            s.examine(mailbox).await.map_err(err)?;
            let fetched: Vec<_> =
                s.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])").await.map_err(err)?.try_collect().await.map_err(err)?;
            let raw = fetched.iter().find_map(|f| f.body()).ok_or("The message is no longer there.")?;
            let msg = MessageParser::default().parse(raw).ok_or("The message couldn't be read.")?;
            // mail-parser turns a plain-text body into HTML on request; only a real HTML part counts here.
            let has_html = msg.html_body.first().and_then(|&i| msg.parts.get(i as usize)).is_some_and(|p| p.is_text_html());
            let attachments = msg
                .attachments()
                .enumerate()
                .map(|(i, p)| Attachment {
                    id: p.content_id().map(str::to_string).unwrap_or_else(|| format!("att-{i}")),
                    filename: p.attachment_name().unwrap_or("attachment").to_string(),
                    mime_type: p
                        .content_type()
                        .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")))
                        .unwrap_or_else(|| "application/octet-stream".into()),
                    size: p.len() as u64,
                })
                .collect();
            Ok(EmailFull {
                body: Some(msg.body_text(0).map(|b| b.into_owned()).unwrap_or_default()),
                body_html: if has_html { msg.body_html(0).map(|b| b.into_owned()) } else { None },
                attachments: Some(attachments),
                message_id: None,
                in_reply_to: None,
                references: None,
            })
        })
        .await
    }

    pub async fn send(&self, compose: &Compose, from: &Mailbox) -> Result<(), String> {
        let message = build_message(compose, from)?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::relay(SMTP_HOST)
            .map_err(err)?
            .credentials(Credentials::new(self.email.clone(), self.app_password.clone()))
            .build();
        transport.send(message).await.map_err(|e| format!("Sending failed: {e}"))?;
        Ok(())
    }

    pub async fn mark_read(&self, id: &str) -> Result<(), String> {
        let (mailbox, uid) = parse_id(id)?;
        self.with(async |s| {
            s.select(mailbox).await.map_err(err)?;
            let _: Vec<_> = s.uid_store(uid.to_string(), "+FLAGS.SILENT (\\Seen)").await.map_err(err)?.try_collect().await.map_err(err)?;
            Ok(())
        })
        .await
    }

    async fn move_in(&self, s: &mut Session, ids: &[String], dest: &str) -> Result<(), String> {
        for (mailbox, uids) in by_mailbox(ids)? {
            if mailbox == dest {
                continue;
            }
            s.select(mailbox).await.map_err(err)?;
            s.uid_mv(uid_set(&uids), dest).await.map_err(err)?;
        }
        Ok(())
    }

    pub async fn move_to(&self, ids: &[String], dest: &str) -> Result<(), String> {
        self.with(async |s| self.move_in(s, ids, dest).await).await
    }

    pub async fn trash(&self, ids: &[String]) -> Result<(), String> {
        self.with(async |s| {
            let trash = self.special_folder(s, FolderType::Trash).await?;
            self.move_in(s, ids, &trash).await
        })
        .await
    }

    pub async fn archive(&self, ids: &[String]) -> Result<(), String> {
        self.with(async |s| {
            let archive = self.special_folder(s, FolderType::All).await?;
            self.move_in(s, ids, &archive).await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_criteria_quote_and_combine() {
        assert_eq!(search_criteria(&SearchParams::default()), "ALL");
        let s = SearchParams {
            from: Some("a\"b@x.org".into()),
            to: Some("me".into()),
            after: Some(Utc.with_ymd_and_hms(2025, 3, 5, 10, 0, 0).unwrap()),
            before: Some(Utc.with_ymd_and_hms(2025, 3, 9, 10, 0, 0).unwrap()),
            subject: Some("/x/".into()),
            subject_is_regex: true,
            ..Default::default()
        };
        assert_eq!(search_criteria(&s), r#"FROM "a\"b@x.org" OR OR TO "me" CC "me" BCC "me" SINCE 5-Mar-2025 BEFORE 10-Mar-2025"#);
    }

    #[test]
    fn ids_split_on_the_last_separator() {
        assert_eq!(parse_id("Folder::Sub::42").unwrap(), ("Folder::Sub", 42));
        assert!(parse_id("nope").is_err());
        let ids = ["INBOX::3".to_string(), "Archive::1".into(), "INBOX::5".into()];
        let grouped = by_mailbox(&ids).unwrap();
        assert_eq!(grouped["INBOX"], vec![3, 5]);
        assert_eq!(uid_set(&grouped["INBOX"]), "3,5");
    }

    #[test]
    fn folders_are_typed_by_flag_then_name() {
        assert_eq!(folder_type("Whatever", &[NameAttribute::Trash]), FolderType::Trash);
        assert_eq!(folder_type("Bulk Mail", &[]), FolderType::Spam);
        assert_eq!(folder_type("Projects", &[]), FolderType::Custom);
    }
}
