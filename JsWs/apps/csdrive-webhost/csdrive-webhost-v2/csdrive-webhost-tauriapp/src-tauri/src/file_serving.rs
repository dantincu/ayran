//! **Serving a file to a page** — whole, or, for the media a page plays, *a piece at a time*.
//!
//! A `<video>` or `<audio>` asks for its file with a `Range` header and seeks by asking for other ranges; answering with the
//! whole file would put all of it in memory (a movie is gigabytes). So a request with a range is answered with **at most
//! [`MAX_PIECE`] bytes** read from the file at that place (`206 Partial Content`, `Content-Range`), and the player asks again
//! as it goes: nothing bigger than a piece is ever held. A request with no range gets the whole file, as it always did (an
//! image, a script, a page).
//!
//! **Cross-origin reads.** The system apps' pages (Notes' media viewer and its thumbnails) show files from the web apps'
//! origin (`csuser`), and to read a picture back from a canvas (a thumbnail) the answer must allow the page's origin. It does,
//! for **this app's own frontend origins only** (`allowed_origin`) — never a web page of the web, which could otherwise read
//! files it has no business with.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::header::CONTENT_TYPE;
use tauri::http::{Response, StatusCode};

/// The most one answer to a range request carries.
pub(crate) const MAX_PIECE: u64 = 4 * 1024 * 1024;

/// What of a request matters for answering it with a file.
#[derive(Debug, Default, Clone)]
pub(crate) struct RequestMeta {
    /// The `Range` header, as sent.
    pub range: Option<String>,
    /// The `Origin` header, as sent (the page's origin when it reads the answer across origins).
    pub origin: Option<String>,
}

impl RequestMeta {
    pub fn of(headers: &tauri::http::HeaderMap) -> Self {
        let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        RequestMeta { range: text("range"), origin: text("origin") }
    }
}

/// What a `Range` header asks of a file of `len` bytes: `Ok(Some((first, last)))` (both included, cut to [`MAX_PIECE`]),
/// `Ok(None)` when there is no (usable) range — the whole file is meant — and `Err(())` when it can't be satisfied.
/// Only a single range of bytes is understood (`bytes=a-b`, `bytes=a-`, `bytes=-n`); any other form is taken as no range.
pub(crate) fn byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((from, to)) = spec.split_once('-') else { return Ok(None) };
    let (from, to) = (from.trim(), to.trim());
    let (first, last) = match (from.is_empty(), to.is_empty()) {
        (true, true) => return Ok(None),
        // The last `n` bytes.
        (true, false) => {
            let n: u64 = to.parse().map_err(|_| ())?;
            if n == 0 || len == 0 {
                return Err(());
            }
            (len.saturating_sub(n), len - 1)
        }
        (false, true) => (from.parse::<u64>().map_err(|_| ())?, len.saturating_sub(1)),
        (false, false) => (from.parse::<u64>().map_err(|_| ())?, to.parse::<u64>().map_err(|_| ())?),
    };
    if first >= len || last < first {
        return Err(());
    }
    Ok(Some((first, last.min(len - 1).min(first + MAX_PIECE - 1))))
}

/// The `Access-Control-Allow-Origin` value for a request from `origin`: the origin itself when it is one of this app's own
/// frontend origins. (On Android the WebView doesn't always say where a request comes from; the only page that asks
/// across origins there is the app's own, so it is answered as such.)
pub(crate) fn allowed_origin(origin: Option<&str>) -> Option<String> {
    const OWN: [&str; 3] = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];
    match origin {
        Some(o) if OWN.contains(&o) => Some(o.to_string()),
        Some(_) => None,
        None if cfg!(target_os = "android") => Some("http://tauri.localhost".to_string()),
        None => None,
    }
}

fn builder(status: StatusCode, content_type: &str, csp: &str, meta: &RequestMeta) -> tauri::http::response::Builder {
    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("Content-Security-Policy", csp)
        .header("Accept-Ranges", "bytes");
    if let Some(origin) = allowed_origin(meta.origin.as_deref()) {
        response = response.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
    }
    response
}

/// The file at `path` as the answer to a request (see the module documentation). A markdown file is the page it becomes.
pub(crate) fn respond_file(path: &Path, meta: &RequestMeta, csp: &str) -> Response<Vec<u8>> {
    let not_found = || crate::respond_text(StatusCode::NOT_FOUND, "File not found", csp);
    let Ok(mut file) = std::fs::File::open(path) else { return not_found() };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return not_found() };
    if crate::markdown::is_markdown(path) {
        let mut data = Vec::new();
        return match file.read_to_end(&mut data) {
            Ok(_) => crate::respond_bytes(path, data, csp),
            Err(_) => not_found(),
        };
    }
    let content_type = crate::content_type_for(path);
    match byte_range(meta.range.as_deref(), len) {
        Ok(None) => {
            let mut data = Vec::with_capacity(len as usize);
            match file.read_to_end(&mut data) {
                Ok(_) => builder(StatusCode::OK, content_type, csp, meta).body(data).unwrap(),
                Err(_) => not_found(),
            }
        }
        Ok(Some((first, last))) => {
            let mut data = vec![0u8; (last - first + 1) as usize];
            if file.seek(SeekFrom::Start(first)).and_then(|_| file.read_exact(&mut data)).is_err() {
                return not_found();
            }
            builder(StatusCode::PARTIAL_CONTENT, content_type, csp, meta).header("Content-Range", format!("bytes {first}-{last}/{len}")).body(data).unwrap()
        }
        Err(()) => builder(StatusCode::RANGE_NOT_SATISFIABLE, "text/plain; charset=utf-8", csp, meta).header("Content-Range", format!("bytes */{len}")).body(Vec::new()).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_is_read_and_cut_to_a_piece() {
        assert_eq!(byte_range(None, 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-9"), 100), Ok(Some((0, 9))));
        assert_eq!(byte_range(Some("bytes=10-"), 100), Ok(Some((10, 99))));
        assert_eq!(byte_range(Some("bytes=-5"), 100), Ok(Some((95, 99))));
        assert_eq!(byte_range(Some("bytes=90-200"), 100), Ok(Some((90, 99))), "past the end is the end");
        // A movie: an open range is answered a piece at a time.
        let len = 5 * 1024 * 1024 * 1024u64;
        assert_eq!(byte_range(Some("bytes=0-"), len), Ok(Some((0, MAX_PIECE - 1))));
        assert_eq!(byte_range(Some(&format!("bytes={}-", len - 10)), len), Ok(Some((len - 10, len - 1))));
    }

    #[test]
    fn a_range_that_cannot_be_satisfied_is_refused_and_odd_ones_mean_the_whole_file() {
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=5-2"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=0-1"), 0), Err(()));
        assert_eq!(byte_range(Some("bytes=x-3"), 100), Err(()));
        assert_eq!(byte_range(Some("items=0-3"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-3, 10-12"), 100), Ok(None), "several ranges are not understood");
    }

    #[test]
    fn only_the_apps_own_pages_may_read_across_origins() {
        assert_eq!(allowed_origin(Some("http://tauri.localhost")).as_deref(), Some("http://tauri.localhost"));
        assert_eq!(allowed_origin(Some("tauri://localhost")).as_deref(), Some("tauri://localhost"));
        assert_eq!(allowed_origin(Some("https://evil.example")), None);
        assert_eq!(allowed_origin(Some("http://csuser.localhost")), None, "not even a web app's origin");
    }

    #[test]
    fn a_file_is_answered_whole_or_in_pieces() {
        let dir = std::env::temp_dir().join(format!("csdrive-file-serving-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        std::fs::write(&file, &bytes).unwrap();

        let whole = respond_file(&file, &RequestMeta::default(), "csp");
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body().len(), 10_000);
        assert_eq!(whole.headers().get("accept-ranges").unwrap(), "bytes");

        let piece = respond_file(&file, &RequestMeta { range: Some("bytes=256-511".into()), origin: None }, "csp");
        assert_eq!(piece.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(piece.body().as_slice(), &bytes[256..512]);
        assert_eq!(piece.headers().get("content-range").unwrap(), "bytes 256-511/10000");

        let tail = respond_file(&file, &RequestMeta { range: Some("bytes=9990-".into()), origin: None }, "csp");
        assert_eq!(tail.body().as_slice(), &bytes[9990..]);

        let beyond = respond_file(&file, &RequestMeta { range: Some("bytes=20000-".into()), origin: None }, "csp");
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(beyond.headers().get("content-range").unwrap(), "bytes */10000");

        let cross = respond_file(&file, &RequestMeta { range: None, origin: Some("http://tauri.localhost".into()) }, "csp");
        assert_eq!(cross.headers().get("access-control-allow-origin").unwrap(), "http://tauri.localhost");
        let foreign = respond_file(&file, &RequestMeta { range: None, origin: Some("https://evil.example".into()) }, "csp");
        assert!(foreign.headers().get("access-control-allow-origin").is_none());

        assert_eq!(respond_file(&dir.join("missing.mp4"), &RequestMeta::default(), "csp").status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
