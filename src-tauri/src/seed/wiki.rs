//! Wikipedia REST random summary fetch for demo seed entry bodies.
//!
//! Uses `GET /api/rest_v1/page/random/summary` on `en` / `vi` Wikipedia.
//! Failures are non-fatal at the call site — the runner falls back to the
//! static catalog when a summary is missing.

use std::time::Duration;

use serde::Deserialize;

/// Descriptive UA required by Wikimedia (no generic library default).
const USER_AGENT: &str = "Memlore-dev-seed/0.1 (local demo seeder; offline-friendly fallback)";

/// Max attempts per entry when the page is empty, disambiguation, or network blips.
const MAX_ATTEMPTS: u32 = 2;

/// Per-request timeout — keep short so offline seed falls back quickly.
const REQUEST_TIMEOUT_SECS: u64 = 8;

/// One Wikipedia article summary turned into seed title + body paragraphs.
#[derive(Debug, Clone)]
pub struct WikiEntryText {
    pub title: String,
    pub paragraphs: Vec<String>,
    pub lang: String,
}

#[derive(Debug, Deserialize)]
struct WikiSummaryJson {
    title: Option<String>,
    extract: Option<String>,
    /// `"standard" | "disambiguation" | "no-extract" | …`
    #[serde(rename = "type")]
    page_type: Option<String>,
    lang: Option<String>,
}

/// Fetch a single random article summary for `lang` (`"en"` or `"vi"`).
///
/// Follows redirects (random → concrete summary). Retries up to
/// [`MAX_ATTEMPTS`] when the page is disambiguation / empty extract.
pub fn fetch_random_summary(lang: &str) -> Result<WikiEntryText, String> {
    let lang = normalize_lang(lang);
    let mut last_err = String::from("wiki: no attempts");

    for _ in 0..MAX_ATTEMPTS {
        match fetch_random_summary_once(lang) {
            Ok(entry) => return Ok(entry),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn normalize_lang(lang: &str) -> &'static str {
    match lang.trim().to_ascii_lowercase().as_str() {
        "vi" | "vietnamese" => "vi",
        _ => "en",
    }
}

fn fetch_random_summary_once(lang: &str) -> Result<WikiEntryText, String> {
    let url = format!("https://{lang}.wikipedia.org/api/rest_v1/page/random/summary");
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("wiki client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("wiki request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("wiki HTTP {}", resp.status()));
    }

    let body: WikiSummaryJson = resp.json().map_err(|e| format!("wiki json: {e}"))?;

    let page_type = body.page_type.as_deref().unwrap_or("standard");
    if page_type == "disambiguation" || page_type == "no-extract" {
        return Err(format!("wiki skip page type {page_type}"));
    }

    let title = body
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "wiki empty title".to_string())?;

    let extract = body
        .extract
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .ok_or_else(|| "wiki empty extract".to_string())?;

    let paragraphs = extract_to_paragraphs(&extract);
    if paragraphs.is_empty() {
        return Err("wiki empty paragraphs".into());
    }

    Ok(WikiEntryText {
        title,
        paragraphs,
        lang: body.lang.unwrap_or_else(|| lang.to_string()),
    })
}

/// Split a Wikipedia extract into 1–3 journal-friendly paragraphs.
pub fn extract_to_paragraphs(extract: &str) -> Vec<String> {
    let trimmed = extract.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // Prefer author-provided paragraph breaks.
    let by_blank: Vec<String> = trimmed
        .split("\n\n")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\n', " "))
        .collect();
    if by_blank.len() > 1 {
        return by_blank.into_iter().take(3).collect();
    }

    let single = by_blank
        .into_iter()
        .next()
        .unwrap_or_else(|| trimmed.replace('\n', " "));

    // Multi-sentence block → split into ~2 paragraph groups when long enough
    // (or when there are 3+ sentences, typical of Wikipedia extracts).
    let sentences = split_sentences(&single);
    if sentences.len() >= 3 || (sentences.len() >= 2 && single.chars().count() > 200) {
        let mid = sentences.len() / 2;
        let first = sentences[..mid].join(" ");
        let second = sentences[mid..].join(" ");
        return vec![first, second]
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect();
    }

    vec![single]
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        buf.push(c);
        if matches!(c, '.' | '!' | '?' | '。') {
            // End of sentence if next is whitespace or end.
            let next_is_break = i + 1 >= n || chars[i + 1].is_whitespace();
            if next_is_break {
                let s = buf.trim().to_string();
                if !s.is_empty() {
                    out.push(s);
                }
                buf.clear();
                while i + 1 < n && chars[i + 1].is_whitespace() {
                    i += 1;
                }
            }
        }
        i += 1;
    }
    let tail = buf.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    out
}

/// Heuristic: catalog body/title looks Vietnamese → prefer `vi` Wikipedia.
pub fn prefers_vietnamese(title: &str, paragraphs: &[&str]) -> bool {
    if has_vietnamese_diacritics(title) {
        return true;
    }
    paragraphs.iter().any(|p| has_vietnamese_diacritics(p))
}

fn has_vietnamese_diacritics(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(
            c,
            'ă' | 'â'
                | 'ê'
                | 'ô'
                | 'ơ'
                | 'ư'
                | 'đ'
                | 'Ă'
                | 'Â'
                | 'Ê'
                | 'Ô'
                | 'Ơ'
                | 'Ư'
                | 'Đ'
                | 'á'
                | 'à'
                | 'ả'
                | 'ã'
                | 'ạ'
                | 'é'
                | 'è'
                | 'ẻ'
                | 'ẽ'
                | 'ẹ'
                | 'í'
                | 'ì'
                | 'ỉ'
                | 'ĩ'
                | 'ị'
                | 'ó'
                | 'ò'
                | 'ỏ'
                | 'õ'
                | 'ọ'
                | 'ú'
                | 'ù'
                | 'ủ'
                | 'ũ'
                | 'ụ'
                | 'ý'
                | 'ỳ'
                | 'ỷ'
                | 'ỹ'
                | 'ỵ'
        )
    })
}

/// Prefetch one random summary per demo entry (index-aligned).
///
/// `None` slots mean the runner should use the static catalog for that entry.
/// After a hard network failure, remaining entries skip Wikipedia so offline
/// seed does not block on N timeouts.
pub fn prefetch_wiki_for_catalog(
    entries: &[crate::seed::catalog::DemoEntry],
) -> Vec<Option<WikiEntryText>> {
    let mut out = Vec::with_capacity(entries.len());
    let mut network_dead = false;

    for demo in entries {
        if network_dead {
            out.push(None);
            continue;
        }

        let lang = if prefers_vietnamese(demo.title, demo.paragraphs) {
            "vi"
        } else {
            "en"
        };

        match fetch_random_summary(lang) {
            Ok(text) => out.push(Some(text)),
            Err(e) => {
                eprintln!("seed wiki: skip entry {:?} ({lang}): {e}", demo.title);
                if is_hard_network_error(&e) {
                    eprintln!(
                        "seed wiki: network unavailable — remaining entries use catalog fallback"
                    );
                    network_dead = true;
                }
                out.push(None);
            }
        }
    }

    out
}

fn is_hard_network_error(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("wiki request:")
        || e.contains("wiki client:")
        || e.contains("timed out")
        || e.contains("timeout")
        || e.contains("connection")
        || e.contains("dns")
        || e.contains("error sending")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_to_paragraphs_single_block() {
        let p = extract_to_paragraphs("  Hello world.  ");
        assert_eq!(p, vec!["Hello world.".to_string()]);
    }

    #[test]
    fn extract_to_paragraphs_blank_split() {
        let p = extract_to_paragraphs("First para.\n\nSecond para.");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0], "First para.");
        assert_eq!(p[1], "Second para.");
    }

    #[test]
    fn extract_to_paragraphs_long_splits_sentences() {
        let long = "Alpha sentence one. Beta sentence two is longer and keeps going. \
                    Gamma sentence three wraps up the extract for the seed.";
        let p = extract_to_paragraphs(long);
        assert!(p.len() >= 2, "expected split of long extract, got {p:?}");
        let joined = p.join(" ");
        assert!(joined.contains("Alpha"));
        assert!(joined.contains("Gamma"));
    }

    #[test]
    fn prefers_vietnamese_detects_diacritics() {
        assert!(prefers_vietnamese("Buổi sáng", &["hello"]));
        assert!(prefers_vietnamese("Title", &["Sáng nay thức dậy."]));
        assert!(!prefers_vietnamese("Morning", &["Woke up early."]));
    }

    #[test]
    fn normalize_lang_maps_vi_and_default_en() {
        assert_eq!(normalize_lang("vi"), "vi");
        assert_eq!(normalize_lang("VI"), "vi");
        assert_eq!(normalize_lang("en"), "en");
        assert_eq!(normalize_lang("fr"), "en");
    }

    /// Network test — run with `cargo test wiki -- --ignored`.
    #[test]
    #[ignore]
    fn fetch_random_summary_en_live() {
        let entry = fetch_random_summary("en").expect("wiki en");
        assert!(!entry.title.is_empty());
        assert!(!entry.paragraphs.is_empty());
        assert!(!entry.paragraphs[0].is_empty());
    }
}
