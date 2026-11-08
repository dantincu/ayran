//! The mail providers, behind one dispatch ([`Service`]) the commands use.

pub mod gmail;
pub mod outlook;
pub mod types;
pub mod yahoo;

use lettre::message::{header::ContentType, Mailbox};
use lettre::Message;
use regex::{Regex, RegexBuilder};

use types::*;

pub enum Service {
    Gmail(gmail::Gmail),
    Outlook(outlook::Outlook),
    Yahoo(yahoo::Yahoo),
}

impl Service {
    pub async fn folders(&self) -> Result<Vec<Folder>, String> {
        match self {
            Service::Gmail(s) => s.folders().await,
            Service::Outlook(s) => s.folders().await,
            Service::Yahoo(s) => s.folders().await,
        }
    }

    pub async fn emails(&self, query: &EmailQuery) -> Result<EmailPage, String> {
        let mut page = match self {
            Service::Gmail(s) => s.emails(query).await?,
            Service::Outlook(s) => s.emails(query).await?,
            Service::Yahoo(s) => s.emails(query).await?,
        };
        regex_filter(&mut page.emails, &query.search)?;
        Ok(page)
    }

    pub async fn email_full(&self, email_id: &str) -> Result<EmailFull, String> {
        match self {
            Service::Gmail(s) => s.email_full(email_id).await,
            // Graph returns the whole body with the list already.
            Service::Outlook(_) => Ok(EmailFull::default()),
            Service::Yahoo(s) => s.email_full(email_id).await,
        }
    }

    pub async fn send(&self, compose: &Compose, from: &Mailbox) -> Result<(), String> {
        match self {
            Service::Gmail(s) => s.send(compose, from).await,
            Service::Outlook(s) => s.send(compose).await,
            Service::Yahoo(s) => s.send(compose, from).await,
        }
    }

    pub async fn mark_read(&self, email_id: &str) -> Result<(), String> {
        match self {
            Service::Gmail(s) => s.modify_labels(&[email_id.to_string()], &[], &["UNREAD".into()]).await,
            Service::Outlook(s) => s.mark_read(email_id).await,
            Service::Yahoo(s) => s.mark_read(email_id).await,
        }
    }

    pub async fn trash(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        match self {
            Service::Gmail(s) => s.modify_labels(ids, &["TRASH".into()], &["INBOX".into()]).await,
            Service::Outlook(s) => s.move_to(ids, "deleteditems").await,
            Service::Yahoo(s) => s.trash(ids).await,
        }
    }

    pub async fn archive(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        match self {
            Service::Gmail(s) => s.modify_labels(ids, &[], &["INBOX".into()]).await,
            Service::Outlook(s) => s.move_to(ids, "archive").await,
            Service::Yahoo(s) => s.archive(ids).await,
        }
    }

    pub async fn modify_labels(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<(), String> {
        match self {
            Service::Gmail(s) if !ids.is_empty() => s.modify_labels(ids, add, remove).await,
            Service::Gmail(_) => Ok(()),
            _ => Err("Labels are a Gmail feature; use folders for this account.".into()),
        }
    }

    pub async fn move_to(&self, ids: &[String], folder_id: &str) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        match self {
            Service::Gmail(_) => Err("Gmail uses labels rather than folders.".into()),
            Service::Outlook(s) => s.move_to(ids, folder_id).await,
            Service::Yahoo(s) => s.move_to(ids, folder_id).await,
        }
    }
}

// ── Addresses ────────────────────────────────────────────────────────────────

/// `"Name" <a@b.c>` or `a@b.c`.
pub fn parse_address(raw: &str) -> EmailAddress {
    let raw = raw.trim();
    if let (Some(lt), true) = (raw.rfind('<'), raw.ends_with('>')) {
        let email = raw[lt + 1..raw.len() - 1].trim().to_string();
        let name = raw[..lt].trim().trim_matches('"').trim().to_string();
        return EmailAddress { name: (!name.is_empty()).then_some(name), email };
    }
    EmailAddress { name: None, email: if raw.is_empty() { "unknown".into() } else { raw.to_string() } }
}

/// A header's address list, split on the commas that aren't inside quotes or angle brackets.
pub fn parse_address_list(raw: &str) -> Vec<EmailAddress> {
    let mut parts = Vec::new();
    let (mut current, mut in_quotes, mut in_angle) = (String::new(), false, false);
    for c in raw.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            '<' if !in_quotes => in_angle = true,
            '>' if !in_quotes => in_angle = false,
            ',' if !in_quotes && !in_angle => {
                parts.push(std::mem::take(&mut current));
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    parts.push(current);
    parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).map(parse_address).collect()
}

/// mail-parser's addresses → ours.
pub fn addresses(value: Option<&mail_parser::Address>) -> Vec<EmailAddress> {
    value
        .map(|a| {
            a.iter()
                .filter_map(|addr| {
                    let email = addr.address()?.to_string();
                    let name = addr.name().map(str::to_string).filter(|n| !n.is_empty());
                    Some(EmailAddress { name, email })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── Search done locally ──────────────────────────────────────────────────────

/// `/pattern/flags` or a bare pattern; case-insensitive unless the flags are given without `i`.
fn build_regex(input: &str) -> Result<Regex, String> {
    let input = input.trim();
    let (pattern, flags) = match input.strip_prefix('/').and_then(|rest| rest.rfind('/').map(|end| (&rest[..end], &rest[end + 1..]))) {
        Some((p, f)) if !p.is_empty() => (p, Some(f).filter(|f| !f.is_empty())),
        _ => (input, None),
    };
    RegexBuilder::new(pattern)
        .case_insensitive(flags.map_or(true, |f| f.contains('i')))
        .multi_line(flags.is_some_and(|f| f.contains('m')))
        .dot_matches_new_line(flags.is_some_and(|f| f.contains('s')))
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("Invalid regular expression: {e}"))
}

/// No provider can search by regular expression, so a regex criterion is applied to the page the
/// provider returned (subject: always; body: to whatever body or preview the list carries).
pub fn regex_filter(emails: &mut Vec<Email>, search: &SearchParams) -> Result<(), String> {
    let subject = match (&search.subject, search.subject_is_regex) {
        (Some(s), true) if !s.trim().is_empty() => Some(build_regex(s)?),
        _ => None,
    };
    let body = match (&search.body, search.body_is_regex) {
        (Some(s), true) if !s.trim().is_empty() => Some(build_regex(s)?),
        _ => None,
    };
    if subject.is_none() && body.is_none() {
        return Ok(());
    }
    emails.retain(|e| {
        subject.as_ref().is_none_or(|r| r.is_match(&e.subject))
            && body.as_ref().is_none_or(|r| {
                r.is_match(&e.body) || r.is_match(&e.snippet) || e.body_html.as_deref().is_some_and(|h| r.is_match(h))
            })
    });
    Ok(())
}

/// Sorting within a page, for providers that can only order by date on the server.
pub fn sort_page(emails: &mut [Email], sort: SortParams) {
    let key = |e: &Email| -> String {
        match sort.field {
            SortField::From => e.from.name.clone().unwrap_or_else(|| e.from.email.clone()).to_lowercase(),
            SortField::To => e.to.first().map(|a| a.email.to_lowercase()).unwrap_or_default(),
            SortField::Date => String::new(),
        }
    };
    match sort.field {
        SortField::Date => emails.sort_by_key(|e| e.date),
        _ => emails.sort_by_key(key),
    }
    if sort.direction == SortDirection::Desc {
        emails.reverse();
    }
}

// ── Outgoing messages ────────────────────────────────────────────────────────

fn mailboxes(list: &str, field: &str) -> Result<Vec<Mailbox>, String> {
    Compose::split(list)
        .iter()
        .map(|a| a.parse::<Mailbox>().map_err(|e| format!("{field}: “{a}” isn't a valid address ({e})")))
        .collect()
}

/// The RFC 5322 message for a compose form (Gmail sends it raw; Yahoo over SMTP). Bcc is kept in the
/// headers: Gmail reads the recipients from them, and lettre's SMTP envelope is built from them too.
pub fn build_message(compose: &Compose, from: &Mailbox) -> Result<Message, String> {
    let to = mailboxes(&compose.to, "To")?;
    if to.is_empty() {
        return Err("Add at least one recipient.".into());
    }
    let mut builder = Message::builder().from(from.clone()).subject(compose.subject.clone()).keep_bcc();
    for m in to {
        builder = builder.to(m);
    }
    for m in mailboxes(&compose.cc, "Cc")? {
        builder = builder.cc(m);
    }
    for m in mailboxes(&compose.bcc, "Bcc")? {
        builder = builder.bcc(m);
    }
    if let Some(id) = compose.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(id.to_string());
    }
    if let Some(refs) = compose.references.as_ref().filter(|r| !r.is_empty()) {
        builder = builder.references(refs.join(" "));
    }
    builder.header(ContentType::TEXT_PLAIN).body(compose.body.clone()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_split_outside_quotes_and_brackets() {
        let list = parse_address_list(r#""Doe, Jane" <jane@x.org>, bob@y.com , <c@z.net>"#);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], EmailAddress { name: Some("Doe, Jane".into()), email: "jane@x.org".into() });
        assert_eq!(list[1], EmailAddress { name: None, email: "bob@y.com".into() });
        assert_eq!(list[2], EmailAddress { name: None, email: "c@z.net".into() });
        assert!(parse_address_list("").is_empty());
    }

    #[test]
    fn regexes_accept_slashes_and_flags() {
        assert!(build_regex("/^Invoice \\d+$/").unwrap().is_match("invoice 42"));
        assert!(!build_regex("/^Invoice/m").unwrap().is_match("invoice"), "flags without i are case-sensitive");
        assert!(build_regex("a/b").unwrap().is_match("A/B"));
        assert!(build_regex("(").is_err());
    }

    #[test]
    fn a_message_keeps_bcc_and_threading_headers() {
        let compose = Compose {
            to: "a@x.org, \"B\" <b@y.org>".into(),
            bcc: "hidden@z.org".into(),
            subject: "Re: hi".into(),
            body: "hello".into(),
            in_reply_to: Some("<m1@x.org>".into()),
            references: Some(vec!["<m0@x.org>".into(), "<m1@x.org>".into()]),
            ..Default::default()
        };
        let from: Mailbox = "me@me.org".parse().unwrap();
        let text = String::from_utf8(build_message(&compose, &from).unwrap().formatted()).unwrap();
        assert!(text.contains("Bcc: hidden@z.org"));
        assert!(text.contains("In-Reply-To: <m1@x.org>"));
        assert!(text.contains("References: <m0@x.org> <m1@x.org>"));
        assert!(build_message(&Compose::default(), &from).is_err(), "no recipient");
        assert!(build_message(&Compose { to: "not an address".into(), ..Default::default() }, &from).is_err());
    }
}
