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
}
