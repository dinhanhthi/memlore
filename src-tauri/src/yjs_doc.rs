//! Build TipTap-compatible Yjs full-state updates for imported and seeded entries.
//!
//! TipTap binds to XmlFragment `"default"`. Paragraphs are `XmlElement("paragraph")`
//! with an `XmlText` child; inline images are sibling `XmlElement("image")` nodes
//! with attributes `data-media-id` and `src` (empty string — the editor resolves
//! media via id).
//!
//! **Do not** use `get_or_insert_text("content")` — that shape is for sync test
//! helpers only and will render a blank editor.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::types::xml::XmlIn;
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

/// Max grapheme-ish length for `preview_text` (char count, not bytes).
const PREVIEW_MAX_CHARS: usize = 200;

/// Ceiling on text read back from a doc; past it the caller keeps its own.
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

/// Encode paragraphs + optional inline media into a TipTap Yjs blob.
///
/// # Document layout
/// - All `paragraphs` are inserted in order as sibling elements under fragment
///   `"default"`.
/// - If `inline_media_ids` is non-empty and there is at least one paragraph, the
///   **first** media node is inserted immediately after the first paragraph;
///   remaining media nodes are appended after the last paragraph.
/// - If there are no paragraphs, all media nodes are appended in order.
///
/// Each media tuple is `(media_id, node_name)` — `node_name` is usually `"image"`.
///
/// Returns `(yjs_update_v1, content_text, preview_text)` where:
/// - `content_text` = paragraphs joined with `\n`, then overall-trimmed
/// - `preview_text` = first [`PREVIEW_MAX_CHARS`] chars of `content_text`
pub fn build_entry_yjs(
    paragraphs: &[&str],
    inline_media_ids: &[(&str /* media_id */, &str /* node name */)],
) -> (
    Vec<u8>,
    String, /* content_text */
    String, /* preview_text */
) {
    let content_text = paragraphs.join("\n").trim().to_string();
    let preview_text: String = content_text.chars().take(PREVIEW_MAX_CHARS).collect();

    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("default");

    {
        let mut txn = doc.transact_mut();
        let mut media = inline_media_ids.iter();

        if paragraphs.is_empty() {
            for (media_id, node_name) in media {
                push_media_node(&fragment, &mut txn, node_name, media_id);
            }
        } else {
            for (i, para) in paragraphs.iter().enumerate() {
                let prelim =
                    XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(*para))]);
                fragment.push_back(&mut txn, prelim);

                // First image goes after the first paragraph.
                if i == 0 {
                    if let Some((media_id, node_name)) = media.next() {
                        push_media_node(&fragment, &mut txn, node_name, media_id);
                    }
                }
            }
            // Remaining images after all paragraphs.
            for (media_id, node_name) in media {
                push_media_node(&fragment, &mut txn, node_name, media_id);
            }
        }
    }

    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    (bytes, content_text, preview_text)
}

fn push_media_node(
    fragment: &yrs::XmlFragmentRef,
    txn: &mut yrs::TransactionMut<'_>,
    node_name: &str,
    media_id: &str,
) {
    let mut attributes = HashMap::new();
    attributes.insert(Arc::from("data-media-id"), media_id.to_string());
    // TipTap Image expects `src`; empty string — runtime resolves via data-media-id.
    attributes.insert(Arc::from("src"), String::new());
    let prelim = XmlElementPrelim {
        tag: Arc::from(node_name),
        attributes,
        children: Vec::new(),
    };
    fragment.push_back(txn, prelim);
}

/// Plain text of a TipTap Yjs blob: `(content_text, preview_text)`, or `None`
/// when the bytes do not decode.
///
/// Mirrors `extractPlainText` in `src/lib/yjs.ts` byte for byte, so a merge
/// point that re-derives the text agrees with what the editor saves. That
/// includes its quirks: `XmlText` keeps its formatting tags (`get_string`,
/// like `Y.XmlText.toString()`), and only all-lowercase block names
/// (`paragraph`, `heading`, `blockquote`) end with a newline, because the TS
/// side lowercases the node name before checking a camelCase set.
pub fn extract_entry_text(yjs_doc: &[u8]) -> Option<(String, String)> {
    use yrs::types::xml::XmlOut;
    use yrs::updates::decoder::Decode;
    use yrs::{Any, Update, Xml};

    /// Deeper than any editor document; a hostile blob nested past this
    /// would otherwise overflow the stack, so the caller keeps its own text.
    const MAX_DEPTH: usize = 256;

    // Everything is written into one buffer, so `MAX_TEXT_BYTES` bounds the
    // whole document, not each node.
    fn element_text(
        el: &yrs::XmlElementRef,
        txn: &impl ReadTxn,
        depth: usize,
        out: &mut String,
    ) -> Option<()> {
        if depth > MAX_DEPTH {
            return None;
        }
        let tag = el.tag().to_lowercase();
        if tag == "mention" {
            // A plain value only: stringifying a shared type would recurse
            // into it with no depth limit.
            if let Some(yrs::Out::Any(label)) = el.get_attribute(txn, "label") {
                if !matches!(label, Any::Null | Any::Undefined) {
                    out.push_str(&js_string(&label));
                }
            }
            return within_budget(out);
        }
        for child in el.children(txn) {
            match child {
                XmlOut::Text(text) => xml_text_string(&text, txn, out)?,
                XmlOut::Element(child) => element_text(&child, txn, depth + 1, out)?,
                XmlOut::Fragment(_) => {}
            }
        }
        if matches!(tag.as_str(), "paragraph" | "heading" | "blockquote") {
            out.push('\n');
        }
        Some(())
    }

    let update = Update::decode_v1(yjs_doc).ok()?;
    let doc = Doc::new();
    doc.transact_mut().apply_update(update).ok()?;
    let txn = doc.transact();
    // Only a TipTap doc has an XmlFragment root; anything else (e.g. a plain
    // `Text` root) has no editor text to read, so the caller keeps its own.
    let fragment = txn.get_xml_fragment("default")?;
    if fragment.len(&txn) as usize != fragment.children(&txn).count() {
        return None;
    }
    let mut text = String::new();
    for child in fragment.children(&txn) {
        match child {
            XmlOut::Text(t) => xml_text_string(&t, &txn, &mut text)?,
            XmlOut::Element(el) => element_text(&el, &txn, 1, &mut text)?,
            XmlOut::Fragment(_) => {}
        }
    }
    // JS `trim()`: Rust's whitespace set plus U+FEFF, minus U+0085.
    let content_text = text
        .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        .to_string();
    let preview_text = content_text.chars().take(PREVIEW_MAX_CHARS).collect();
    Some((content_text, preview_text))
}

/// `None` once the text read back from a doc passes [`MAX_TEXT_BYTES`].
fn within_budget(out: &str) -> Option<()> {
    (out.len() <= MAX_TEXT_BYTES).then_some(())
}

/// `Y.XmlText.toString()` appended to `out`: each run wrapped in its marks as
/// tags, mark names and attribute keys sorted (yrs `get_string` keeps HashMap
/// order, so a link would come out in a different shape on every run).
fn xml_text_string(text: &yrs::XmlTextRef, txn: &impl ReadTxn, out: &mut String) -> Option<()> {
    use yrs::types::text::YChange;
    use yrs::{Any, Out, Text};

    for delta in text.diff(txn, YChange::identity) {
        let mut marks: Vec<(String, Vec<(String, String)>)> = delta
            .attributes
            .iter()
            .flat_map(|attrs| attrs.iter())
            .filter(|(_, value)| !matches!(value, Any::Null | Any::Undefined))
            .map(|(name, value)| {
                // `for…in` over a mark's value: an object lists its keys, a
                // `true` flag (bold, italic) lists none.
                let mut attrs: Vec<(String, String)> = match value {
                    Any::Map(map) => map.iter().map(|(k, v)| (k.clone(), js_string(v))).collect(),
                    _ => Vec::new(),
                };
                attrs.sort();
                (name.to_string(), attrs)
            })
            .collect();
        marks.sort();
        for (name, attrs) in &marks {
            out.push('<');
            out.push_str(name);
            for (key, value) in attrs {
                out.push_str(&format!(" {key}=\"{value}\""));
            }
            out.push('>');
        }
        // A shared-type embed is skipped: stringifying it would recurse into
        // it with no depth limit, and the editor never puts one in text.
        if let Out::Any(any) = &delta.insert {
            out.push_str(&js_string(any));
        }
        for (name, _) in marks.iter().rev() {
            out.push_str(&format!("</{name}>"));
        }
        // Every run repeats its tags, so a blob that toggles many marks per
        // run would grow the text far past its own size.
        within_budget(out)?;
    }
    Some(())
}

/// A value as JS template-literal interpolation prints it.
fn js_string(value: &yrs::Any) -> String {
    js_string_at(value, 0)
}

fn js_string_at(value: &yrs::Any, depth: usize) -> String {
    use yrs::Any;
    match value {
        Any::Null => "null".into(),
        Any::Undefined => "undefined".into(),
        Any::Bool(b) => b.to_string(),
        Any::Number(n) => n.to_string(),
        Any::BigInt(n) => n.to_string(),
        Any::String(s) => s.to_string(),
        // `join` prints null and undefined items as empty.
        Any::Array(_) if depth >= 32 => String::new(),
        Any::Array(items) => items
            .iter()
            .map(|item| match item {
                Any::Null | Any::Undefined => String::new(),
                item => js_string_at(item, depth + 1),
            })
            .collect::<Vec<_>>()
            .join(","),
        Any::Buffer(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        Any::Map(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::types::xml::XmlOut;
    use yrs::updates::decoder::Decode;
    use yrs::{Any, GetString, Out, ReadTxn, Update, Xml};

    fn apply_update(bytes: &[u8]) -> Doc {
        let update = Update::decode_v1(bytes).expect("decode yjs update v1");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply update");
        }
        doc
    }

    fn attr_string(elem: &yrs::XmlElementRef, txn: &impl ReadTxn, name: &str) -> Option<String> {
        match elem.get_attribute(txn, name)? {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            other => Some(other.to_string(txn)),
        }
    }

    fn paragraph_text(elem: &yrs::XmlElementRef, txn: &impl ReadTxn) -> String {
        let mut out = String::new();
        for child in elem.children(txn) {
            if let XmlOut::Text(text) = child {
                out.push_str(&text.get_string(txn));
            }
        }
        out
    }

    #[test]
    fn encode_paragraphs_only_roundtrips_fragment_shape() {
        let paras = ["Hello world", "Second line"];
        let (bytes, content_text, preview_text) = build_entry_yjs(&paras, &[]);

        assert!(!bytes.is_empty());
        assert_eq!(content_text, "Hello world\nSecond line");
        assert_eq!(preview_text, content_text);

        let doc = apply_update(&bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();

        assert_eq!(fragment.len(&txn), 2, "two paragraph siblings");

        let children: Vec<XmlOut> = fragment.children(&txn).collect();
        assert_eq!(children.len(), 2);

        match &children[0] {
            XmlOut::Element(el) => {
                assert_eq!(el.tag().as_ref(), "paragraph");
                assert_eq!(paragraph_text(el, &txn), "Hello world");
            }
            other => panic!("expected paragraph element, got {other:?}"),
        }
        match &children[1] {
            XmlOut::Element(el) => {
                assert_eq!(el.tag().as_ref(), "paragraph");
                assert_eq!(paragraph_text(el, &txn), "Second line");
            }
            other => panic!("expected paragraph element, got {other:?}"),
        }
    }

    #[test]
    fn encode_with_image_sets_data_media_id() {
        let media_id = "media-uuid-abc";
        let (bytes, _, _) = build_entry_yjs(&["Caption para", "More text"], &[(media_id, "image")]);

        let doc = apply_update(&bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();

        // Layout: para0, image, para1
        assert_eq!(fragment.len(&txn), 3);

        let children: Vec<XmlOut> = fragment.children(&txn).collect();
        match &children[0] {
            XmlOut::Element(el) => assert_eq!(el.tag().as_ref(), "paragraph"),
            _ => panic!("child 0 should be paragraph"),
        }
        match &children[1] {
            XmlOut::Element(el) => {
                assert_eq!(el.tag().as_ref(), "image");
                assert_eq!(
                    attr_string(el, &txn, "data-media-id").as_deref(),
                    Some(media_id)
                );
                assert_eq!(attr_string(el, &txn, "src").as_deref(), Some(""));
            }
            _ => panic!("child 1 should be image"),
        }
        match &children[2] {
            XmlOut::Element(el) => {
                assert_eq!(el.tag().as_ref(), "paragraph");
                assert_eq!(paragraph_text(el, &txn), "More text");
            }
            _ => panic!("child 2 should be paragraph"),
        }
    }

    #[test]
    fn content_text_and_preview_text_shape() {
        let long = "a".repeat(250);
        let (bytes, content_text, preview_text) =
            build_entry_yjs(&["  line one  ", long.as_str()], &[]);

        // join with `\n` then overall trim of the joined string.
        let expected = format!("  line one  \n{long}").trim().to_string();
        assert_eq!(content_text, expected);
        assert_eq!(preview_text.chars().count(), PREVIEW_MAX_CHARS);
        assert!(content_text.starts_with(&preview_text));
        assert!(!bytes.is_empty());
    }

    #[test]
    fn multiple_images_first_after_first_para_rest_at_end() {
        let (bytes, _, _) = build_entry_yjs(
            &["P1", "P2"],
            &[("m1", "image"), ("m2", "image"), ("m3", "image")],
        );
        let doc = apply_update(&bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        // P1, m1, P2, m2, m3
        assert_eq!(fragment.len(&txn), 5);

        let tags: Vec<String> = fragment
            .children(&txn)
            .map(|c| match c {
                XmlOut::Element(el) => el.tag().to_string(),
                _ => "other".into(),
            })
            .collect();
        assert_eq!(
            tags,
            vec!["paragraph", "image", "paragraph", "image", "image"]
        );

        let children: Vec<XmlOut> = fragment.children(&txn).collect();
        if let XmlOut::Element(el) = &children[1] {
            assert_eq!(
                attr_string(el, &txn, "data-media-id").as_deref(),
                Some("m1")
            );
        }
        if let XmlOut::Element(el) = &children[3] {
            assert_eq!(
                attr_string(el, &txn, "data-media-id").as_deref(),
                Some("m2")
            );
        }
        if let XmlOut::Element(el) = &children[4] {
            assert_eq!(
                attr_string(el, &txn, "data-media-id").as_deref(),
                Some("m3")
            );
        }
    }

    #[test]
    fn media_only_without_paragraphs() {
        let (bytes, content_text, preview_text) = build_entry_yjs(&[], &[("solo-media", "image")]);
        assert_eq!(content_text, "");
        assert_eq!(preview_text, "");

        let doc = apply_update(&bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        assert_eq!(fragment.len(&txn), 1);
        match fragment.get(&txn, 0) {
            Some(XmlOut::Element(el)) => {
                assert_eq!(el.tag().as_ref(), "image");
                assert_eq!(
                    attr_string(&el, &txn, "data-media-id").as_deref(),
                    Some("solo-media")
                );
            }
            other => panic!("expected image element, got {other:?}"),
        }
    }

    /// Fixture encoded by yjs and read by `extractPlainText` (src/lib/yjs.ts):
    /// heading, a bold run, a mention, a link (mark with attributes), marks
    /// with nested values, an empty paragraph, a nested bullet list, an image
    /// and trailing spaces. The Rust side must match exactly,
    /// or every merge would rewrite `content_text` in another shape.
    #[test]
    fn extract_entry_text_matches_the_typescript_extractor() {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("ASbw5cCYCgAHAQdkZWZhdWx0AwdoZWFkaW5nBwDw5cCYCgAGBADw5cCYCgELVGnDqnUgxJHhu4EoAPDlwJgKAAVsZXZlbAF3ATKH8OXAmAoAAwlwYXJhZ3JhcGgHAPDlwJgKCgYEAPDlwJgKCwRYaW4ghvDlwJgKDwRib2xkBHRydWWE8OXAmAoQBWNow6BvhvDlwJgKFARib2xkBG51bGzE8OXAmAoU8OXAmAoVByBi4bqhbiCH8OXAmAoLAwdtZW50aW9uKADw5cCYChsCaWQBdwJlMSgA8OXAmAobBWxhYmVsAXcISMO0bSBxdWGH8OXAmAobBgQA8OXAmAoeBiBuaMOpIIbw5cCYCiMEbGlua2F7ImhyZWYiOiJodHRwczovL3gudm4vYT9iPTEiLCJ0YXJnZXQiOiJfYmxhbmsiLCJyZWwiOiJub29wZW5lciBub3JlZmVycmVyIG5vZm9sbG93IiwiY2xhc3MiOm51bGx9hvDlwJgKJAZpdGFsaWMEdHJ1ZYTw5cCYCiUEc2l0ZYbw5cCYCikEbGluawRudWxshvDlwJgKKgZpdGFsaWMEbnVsbITw5cCYCisDIG49hvDlwJgKLgRjb2RlBHRydWWG8OXAmAovCXRleHRTdHlsZRx7ImNvbG9yIjoiI2YwMCIsInNpemUiOjEyLjV9hPDlwJgKMAEyhvDlwJgKMQRjb2RlBG51bGyG8OXAmAoyCXRleHRTdHlsZQRudWxsh/DlwJgKCgMJcGFyYWdyYXBoh/DlwJgKNAMKYnVsbGV0TGlzdAcA8OXAmAo1AwhsaXN0SXRlbQcA8OXAmAo2AwlwYXJhZ3JhcGgHAPDlwJgKNwYEAPDlwJgKOAVt4buZdIfw5cCYCjUDBWltYWdlKADw5cCYCjwNZGF0YS1tZWRpYS1pZAF3Am0xh/DlwJgKPAMJcGFyYWdyYXBoBwDw5cCYCj4GBADw5cCYCj8IY3Xhu5FpICAA")
            .unwrap();
        let (content, preview) = extract_entry_text(&bytes).expect("decodes");
        assert_eq!(
            content,
            "Tiêu đề\nXin <bold>chào bạn </bold>Hôm qua nhé <italic><link class=\"null\" href=\"https://x.vn/a?b=1\" rel=\"noopener noreferrer nofollow\" target=\"_blank\">site</link></italic> n=<code><textStyle color=\"#f00\" size=\"12.5\">2</textStyle></code>\n\nmột\ncuối"
        );
        assert_eq!(
            preview,
            content.chars().take(PREVIEW_MAX_CHARS).collect::<String>()
        );
    }

    #[test]
    fn extract_entry_text_gives_up_past_the_depth_cap() {
        let nested = |levels: usize| {
            let mut node =
                XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new("x"))]);
            for _ in 0..levels {
                node = XmlElementPrelim::new("blockquote", [XmlIn::from(node)]);
            }
            let doc = Doc::new();
            doc.get_or_insert_xml_fragment("default")
                .push_back(&mut doc.transact_mut(), node);
            let bytes = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            bytes
        };
        assert!(extract_entry_text(&nested(10)).is_some());
        assert!(extract_entry_text(&nested(300)).is_none());
    }

    #[test]
    fn extract_entry_text_gives_up_past_the_size_budget() {
        let chunk = "a".repeat(MAX_TEXT_BYTES / 4);
        let paragraphs = [chunk.as_str(); 5];
        let (bytes, _, _) = build_entry_yjs(&paragraphs, &[]);
        assert!(extract_entry_text(&bytes).is_none());
        let (bytes, _, _) = build_entry_yjs(&paragraphs[..3], &[]);
        assert!(extract_entry_text(&bytes).is_some());
    }

    #[test]
    fn extract_entry_text_caps_preview_and_rejects_garbage() {
        let long = "a".repeat(PREVIEW_MAX_CHARS + 50);
        let (bytes, _, _) = build_entry_yjs(&[long.as_str()], &[]);
        let (content, preview) = extract_entry_text(&bytes).unwrap();
        assert_eq!(content, long);
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS);
        assert!(extract_entry_text(&[0xff, 0x00, 0x13]).is_none());

        // A plain `Text` root (sync test helpers) is not editor content.
        let doc = Doc::new();
        {
            use yrs::Text;
            doc.get_or_insert_text("default")
                .push(&mut doc.transact_mut(), "plain");
        }
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        assert!(extract_entry_text(&bytes).is_none());
    }
}
