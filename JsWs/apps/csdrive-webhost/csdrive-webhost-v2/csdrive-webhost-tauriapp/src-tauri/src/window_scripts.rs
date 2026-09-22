//! What a page shown in an Android window (see `android_windows.rs`) is given besides its own content: one script that builds
//! the page's Tauri API on the window's bridge (`scripts/window-bridge.js`), brings Tauri's own `window.__TAURI__` (the exact
//! bundle of the Tauri version this is built with — `build.rs` copies it), and freezes the page's address (`code_snippets`).
//!
//! It is served from the page's own origin at [`SCRIPT_PATH`] — so the CSP's `script-src 'self'` covers it, it is cached, and
//! a page's own file at that address can never shadow it (the address is answered before the page's files are looked at) —
//! and a `<script src>` for it is put first in every html document [`with_script_in_head`] sees. Platform independent, so it is
//! tested on every platform.

#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use crate::code_snippets::FROZEN_ADDRESS_INIT_SCRIPT;

/// Where the script is served, on every origin a window's page can be at.
pub const SCRIPT_PATH: &str = "/@csdrive/window.js";

const BRIDGE: &str = include_str!("../scripts/window-bridge.js");
const TAURI_GLOBAL: &str = include_str!(concat!(env!("OUT_DIR"), "/tauri-global.js"));

/// The whole script, in the order it must run: the internals first, then the API built on them, then the freeze.
pub fn script() -> String {
    format!("{BRIDGE}\n{TAURI_GLOBAL}\n{FROZEN_ADDRESS_INIT_SCRIPT}\n")
}

const TAG: &str = "<script src=\"/@csdrive/window.js\"></script>";

/// `html` with the script tag first in its `<head>` — or, for a document with no head, right after its `<html>` tag, or
/// after its doctype, or at the very start. (Before the doctype only as the last resort: it would put the page in quirks mode.)
pub fn with_script_in_head(html: &str) -> String {
    with_tag_in_head(html, TAG)
}

fn with_tag_in_head(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let after_tag = |name: &str| -> Option<usize> {
        let mut from = 0;
        while let Some(found) = lower[from..].find(name) {
            let start = from + found;
            let next = lower.as_bytes().get(start + name.len()).copied();
            if matches!(next, Some(b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/')) {
                return lower[start..].find('>').map(|end| start + end + 1);
            }
            from = start + name.len();
        }
        None
    };
    let at = after_tag("<head").or_else(|| after_tag("<html")).or_else(|| {
        let trimmed = lower.trim_start();
        if trimmed.starts_with("<!doctype") {
            let start = lower.len() - trimmed.len();
            trimmed.find('>').map(|end| start + end + 1)
        } else {
            None
        }
    });
    let at = at.unwrap_or(0);
    format!("{}{tag}{}", &html[..at], &html[at..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_tag_goes_first_in_the_head() {
        assert_eq!(with_script_in_head("<!doctype html><html><head><title>x</title></head>"), format!("<!doctype html><html><head>{TAG}<title>x</title></head>"));
        assert_eq!(with_script_in_head("<HEAD lang=en><body>"), format!("<HEAD lang=en>{TAG}<body>"), "any case, with attributes");
    }

    #[test]
    fn a_header_element_is_not_a_head() {
        let html = "<html><body><header>x</header></body></html>";
        assert_eq!(with_script_in_head(html), format!("<html>{TAG}<body><header>x</header></body></html>"));
    }

    #[test]
    fn a_document_without_a_head_gets_it_after_html_or_the_doctype_never_before_the_doctype() {
        assert_eq!(with_script_in_head("<!DOCTYPE html>\n<html lang=\"en\"><p>hi"), format!("<!DOCTYPE html>\n<html lang=\"en\">{TAG}<p>hi"));
        assert_eq!(with_script_in_head("<!DOCTYPE html>\n<p>hi"), format!("<!DOCTYPE html>{TAG}\n<p>hi"));
        assert_eq!(with_script_in_head("<p>hi"), format!("{TAG}<p>hi"));
        assert_eq!(with_script_in_head(""), TAG);
    }

    #[test]
    fn multibyte_text_before_the_head_does_not_break_the_offsets() {
        assert_eq!(with_script_in_head("<!-- ă ț --><head></head>"), format!("<!-- ă ț --><head>{TAG}</head>"));
    }

    #[test]
    fn the_script_carries_the_bridge_the_tauri_api_and_the_freeze_in_that_order() {
        let script = script();
        let bridge = script.find("__TAURI_INTERNALS__").unwrap();
        let api = script.find("window.__TAURI__=__TAURI_IIFE__").expect("Tauri's own global script");
        let freeze = script.find("A page cannot change its own address").unwrap();
        assert!(bridge < api && api < freeze);
        assert!(script.contains("CsdriveBridge"));
    }
}
