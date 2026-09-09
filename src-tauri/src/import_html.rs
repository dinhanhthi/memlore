//! Journey HTML → title + paragraphs, without an HTML crate.
//!
//! Real Journey v2 `text` is HTML (`<h1>`, `<p dir="auto">`, entities). Existing
//! fixtures are plaintext. Day One and `.md` files go through
//! [`crate::import_markdown`]; only plaintext stays on [`paragraphs_from_plain`].

/// Parsed import body: optional title (first `<h1>` or caller-supplied) and
/// stripped paragraphs ready for [`crate::yjs_doc::build_entry_yjs`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedImportText {
    pub title: Option<String>,
    pub paragraphs: Vec<String>,
}

/// Filenames referenced by `<img src>` in Journey HTML.
///
/// Empty means the export does not distinguish inline vs attached media —
/// importers should attach every photo. External / javascript / data URLs
/// are ignored.
pub fn journey_inline_media_filenames(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && starts_with_ignore_ascii_case(&bytes[i + 1..], b"img") {
            let rest = &text[i..];
            if let Some((tag, _, consumed)) = parse_tag(rest) {
                if tag.eq_ignore_ascii_case("img") {
                    if let Some(src) = html_attr(rest, consumed, "src") {
                        if let Some(name) = journey_local_media_filename(&src) {
                            if !names.iter().any(|existing| existing == &name) {
                                names.push(name);
                            }
                        }
                    }
                    i += consumed;
                    continue;
                }
            }
        }
        i += 1;
    }
    names
}

fn starts_with_ignore_ascii_case(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len()
        && hay[..needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn html_attr(tag_open: &str, consumed: usize, name: &str) -> Option<String> {
    let open = &tag_open[..consumed.min(tag_open.len())];
    let needle = format!("{name}=");
    let bytes = open.as_bytes();
    let needle_bytes = needle.as_bytes();
    let mut i = 0;
    while i + needle_bytes.len() <= bytes.len() {
        if starts_with_ignore_ascii_case(&bytes[i..], needle_bytes) {
            let after = &open[i + needle.len()..];
            return html_attr_value(after);
        }
        i += 1;
    }
    None
}

fn html_attr_value(after_eq: &str) -> Option<String> {
    let trimmed = after_eq.trim_start();
    let bytes = trimmed.as_bytes();
    let quote = *bytes.first()?;
    if quote == b'"' || quote == b'\'' {
        let rest = &trimmed[1..];
        let end = rest.find(quote as char)?;
        return Some(decode_entities(&rest[..end]));
    }
    let end = trimmed
        .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        .unwrap_or(trimmed.len());
    if end == 0 {
        None
    } else {
        Some(decode_entities(&trimmed[..end]))
    }
}

fn journey_local_media_filename(src: &str) -> Option<String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("data:")
        || lower.starts_with("javascript:")
        || lower.starts_with("file:")
    {
        return None;
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && !name.contains('\0'))
        .map(ToOwned::to_owned)
}

/// Convert Journey `text` into a title + paragraphs.
///
/// When `existing_title` is non-empty it wins; a first `<h1>` is then kept as
/// a body paragraph. When `existing_title` is empty, the first `<h1>` becomes
/// the title and is omitted from the body.
pub fn parse_journey_text(text: &str, existing_title: Option<&str>) -> ParsedImportText {
    let existing = existing_title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    if !looks_like_html(text) {
        return ParsedImportText {
            title: existing,
            paragraphs: paragraphs_from_plain(text),
        };
    }

    let (extracted_title, mut paragraphs) = html_to_title_and_paragraphs(text);
    let title = match existing {
        Some(t) => {
            if let Some(h1) = extracted_title {
                paragraphs.insert(0, h1);
            }
            Some(t)
        }
        None => extracted_title,
    };
    ParsedImportText { title, paragraphs }
}

/// Split already-plain / markdown body on blank lines. Single newlines stay
/// inside a paragraph.
pub fn paragraphs_from_plain(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// True only for known Journey/HTML block-or-inline tags — not `<average>` or
/// `<https://…>`. Linear scan (no `contains` from each `<`).
fn looks_like_html(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let start = if bytes.get(i + 1) == Some(&b'/') {
                i + 2
            } else {
                i + 1
            };
            if let Some(name) = peek_ascii_tag_name(&bytes[start..]) {
                if is_known_html_tag(name) {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn peek_ascii_tag_name(bytes: &[u8]) -> Option<&str> {
    let mut end = 0;
    while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
        end += 1;
    }
    if end == 0 {
        return None;
    }
    std::str::from_utf8(&bytes[..end]).ok()
}

fn is_known_html_tag(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "h1" | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "p"
            | "div"
            | "br"
            | "li"
            | "ul"
            | "ol"
            | "span"
            | "strong"
            | "em"
            | "b"
            | "i"
            | "a"
            | "blockquote"
            | "hr"
            | "pre"
            | "code"
            | "img"
            | "script"
            | "style"
    )
}

fn is_skipped_subtree(tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "iframe" | "svg" | "noscript" | "template"
    )
}

fn html_to_title_and_paragraphs(html: &str) -> (Option<String>, Vec<String>) {
    let mut title: Option<String> = None;
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    let mut rest = html;

    while !rest.is_empty() {
        if rest.as_bytes()[0] == b'<' {
            if let Some((tag, is_close, consumed)) = parse_tag(rest) {
                let tag_l = tag.to_ascii_lowercase();
                rest = &rest[consumed..];

                if !is_close && is_skipped_subtree(&tag_l) {
                    let (_, skip) = take_until_close_tag(rest, &tag_l);
                    rest = &rest[skip..];
                    continue;
                }

                if !is_close && tag_l == "h1" && title.is_none() {
                    let (inner, next) = take_until_close_tag(rest, "h1");
                    rest = &rest[next..];
                    let extracted = decode_entities(&strip_tags(&inner));
                    let extracted = extracted.trim();
                    if !extracted.is_empty() {
                        title = Some(extracted.to_string());
                    }
                    continue;
                }

                if is_block_tag(&tag_l) {
                    flush_para(&mut current, &mut paragraphs);
                }
                continue;
            }
        }
        let ch = rest.chars().next().expect("non-empty rest");
        current.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    flush_para(&mut current, &mut paragraphs);
    (title, paragraphs)
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div" | "br" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "hr"
    )
}

fn flush_para(current: &mut String, paragraphs: &mut Vec<String>) {
    let decoded = decode_entities(current);
    let trimmed = decoded.trim();
    if !trimmed.is_empty() {
        paragraphs.push(trimmed.to_string());
    }
    current.clear();
}

/// Returns `(tag_name, is_close, consumed_bytes)`.
fn parse_tag(s: &str) -> Option<(String, bool, usize)> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'<') {
        return None;
    }
    let mut i = 1;
    if i >= bytes.len() {
        return None;
    }

    if matches!(bytes[i], b'!' | b'?') {
        while i < bytes.len() && bytes[i] != b'>' {
            i += 1;
        }
        if i < bytes.len() {
            i += 1;
        }
        return Some((String::new(), true, i));
    }

    let is_close = bytes[i] == b'/';
    if is_close {
        i += 1;
    }

    let name_start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let tag = std::str::from_utf8(&bytes[name_start..i]).ok()?.to_string();

    let mut in_quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_quote {
            if c == q {
                in_quote = None;
            }
            i += 1;
            continue;
        }
        if c == b'"' || c == b'\'' {
            in_quote = Some(c);
            i += 1;
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'>') {
            return Some((tag, is_close, i + 2));
        }
        if c == b'>' {
            return Some((tag, is_close, i + 1));
        }
        i += 1;
    }
    None
}

fn take_until_close_tag(s: &str, tag: &str) -> (String, usize) {
    let mut inner = String::new();
    let mut i = 0;
    while i < s.len() {
        if s.as_bytes()[i] == b'<' {
            if let Some((t, is_close, consumed)) = parse_tag(&s[i..]) {
                if is_close && t.eq_ignore_ascii_case(tag) {
                    return (inner, i + consumed);
                }
                inner.push_str(&s[i..i + consumed]);
                i += consumed;
                continue;
            }
        }
        let ch = s[i..].chars().next().expect("char at byte index");
        inner.push(ch);
        i += ch.len_utf8();
    }
    (inner, i)
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while !rest.is_empty() {
        if rest.as_bytes()[0] == b'<' {
            if let Some((_, _, consumed)) = parse_tag(rest) {
                rest = &rest[consumed..];
                continue;
            }
        }
        let ch = rest.chars().next().expect("non-empty rest");
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        if rest.as_bytes()[0] == b'&' {
            if let Some((decoded, consumed)) = decode_entity(rest) {
                out.push_str(&decoded);
                rest = &rest[consumed..];
                continue;
            }
        }
        let ch = rest.chars().next().expect("non-empty rest");
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn decode_entity(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'&') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() && i <= 10 {
        if bytes[i] == b';' {
            let name = std::str::from_utf8(&bytes[1..i]).ok()?;
            let decoded = named_or_numeric_entity(name)?;
            return Some((decoded, i + 1));
        }
        i += 1;
    }
    None
}

fn named_or_numeric_entity(name: &str) -> Option<String> {
    match name {
        "amp" => Some("&".into()),
        "lt" => Some("<".into()),
        "gt" => Some(">".into()),
        "nbsp" => Some(" ".into()),
        "quot" => Some("\"".into()),
        "apos" => Some("'".into()),
        rest if rest.starts_with('#') => decode_numeric(&rest[1..]),
        _ => None,
    }
}

fn decode_numeric(rest: &str) -> Option<String> {
    let code = if let Some(hex) = rest.strip_prefix(['x', 'X']) {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        rest.parse::<u32>().ok()?
    };
    let c = char::from_u32(code)?;
    if c == '\t' || c == '\n' || c == '\r' || !c.is_control() {
        Some(c.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_extracts_h1_title_and_strips_paragraph() {
        let parsed = parse_journey_text(
            "<h1>Đám giỗ ngoại</h1><p dir=\"auto\">Hôm nay là tròn 3 năm.</p>",
            None,
        );
        assert_eq!(parsed.title.as_deref(), Some("Đám giỗ ngoại"));
        assert_eq!(
            parsed.paragraphs,
            vec!["Hôm nay là tròn 3 năm.".to_string()]
        );
    }

    #[test]
    fn plaintext_is_single_paragraph() {
        let parsed = parse_journey_text("Journey entry one", None);
        assert_eq!(parsed.title, None);
        assert_eq!(parsed.paragraphs, vec!["Journey entry one".to_string()]);
    }

    #[test]
    fn decodes_amp_and_nbsp() {
        let parsed = parse_journey_text("<p>Tom &amp; Jerry&nbsp;ok</p>", None);
        assert_eq!(parsed.paragraphs, vec!["Tom & Jerry ok".to_string()]);
    }

    #[test]
    fn existing_title_wins_and_h1_stays_in_body() {
        let parsed = parse_journey_text("<h1>From html</h1><p>Body</p>", Some("Given"));
        assert_eq!(parsed.title.as_deref(), Some("Given"));
        assert_eq!(
            parsed.paragraphs,
            vec!["From html".to_string(), "Body".to_string()]
        );
    }

    #[test]
    fn blank_lines_split_plain_paragraphs() {
        assert_eq!(
            paragraphs_from_plain("one\n\ntwo"),
            vec!["one".to_string(), "two".to_string()]
        );
        assert_eq!(
            paragraphs_from_plain("one\ntwo"),
            vec!["one\ntwo".to_string()]
        );
    }

    #[test]
    fn angle_bracket_words_stay_plaintext() {
        let parsed = parse_journey_text("I scored <average> today", None);
        assert_eq!(parsed.title, None);
        assert_eq!(
            parsed.paragraphs,
            vec!["I scored <average> today".to_string()]
        );
    }

    #[test]
    fn skips_script_and_style_inner_text() {
        let parsed =
            parse_journey_text("<script>alert(1)</script><p>ok</p><style>x{}</style>", None);
        assert_eq!(parsed.paragraphs, vec!["ok".to_string()]);
    }

    #[test]
    fn journey_inline_media_filenames_collects_local_img_src() {
        let names = journey_inline_media_filenames(
            r#"<p>before</p><img src="photos/in.jpg"><p>mid</p><IMG SRC='extra.png'>"#,
        );
        assert_eq!(names, vec!["in.jpg".to_string(), "extra.png".to_string()]);
    }

    #[test]
    fn journey_inline_media_filenames_ignore_remote_and_empty() {
        let names = journey_inline_media_filenames(
            r#"<img src="https://example.com/x.jpg"><img src=""><img>"#,
        );
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn heading_only_html_extracts_title() {
        let parsed = parse_journey_text("<h1>Only title</h1>", None);
        assert_eq!(parsed.title.as_deref(), Some("Only title"));
        assert!(parsed.paragraphs.is_empty());
    }
}
