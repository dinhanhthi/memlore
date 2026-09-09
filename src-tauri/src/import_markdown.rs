//! Markdown → TipTap-compatible Yjs update (imports).
//!
//! Day One and `markdown_folder` entry bodies are Markdown. Storing them as
//! literal paragraphs (the old [`crate::import_html::paragraphs_from_plain`]
//! path) left `# heading`, `**bold**` and fenced code visible as syntax. This
//! module walks `pulldown-cmark` events and builds the same XmlFragment shape
//! `y-prosemirror` produces for the live editor.
//!
//! Node/mark names must match the TipTap schema in
//! `src/components/editor/sharedExtensions.ts`. Element attributes that the
//! schema treats as numbers (`heading.level`, `orderedList.start`) must be
//! written as [`Any::Number`] — `Any::BigInt` decodes to a JS `BigInt` on the
//! frontend and every heading would fall back to h1.

use std::collections::HashMap;
use std::sync::Arc;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use yrs::types::Attrs;
use yrs::{
    Any, Doc, ReadTxn, StateVector, Text, Transact, TransactionMut, Xml, XmlElementPrelim,
    XmlElementRef, XmlFragment, XmlFragmentRef, XmlTextPrelim, XmlTextRef,
};

/// Split a leading ATX heading (`# Title`) off the body and use it as the title.
///
/// Day One has no title field: the convention is a first-line heading. Returns
/// `(title, remaining_markdown)`.
pub fn split_leading_heading(markdown: &str) -> (Option<String>, &str) {
    let trimmed = markdown.trim();
    let line = trimmed.lines().next().unwrap_or("");
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return (None, trimmed);
    }
    if !line[hashes..].starts_with([' ', '\t']) {
        return (None, trimmed);
    }
    // Parse the heading line so Day One's escapes (`Ng\u{e0}y 1\\.`) and inline
    // marks are resolved the same way the body is.
    let (_, title, _) = build_entry_yjs_from_markdown(line, |_| None);
    if title.is_empty() {
        return (None, trimmed);
    }
    (Some(title), trimmed[line.len()..].trim())
}

/// Convert Markdown into a TipTap Yjs update.
///
/// `resolve_image` maps a Markdown image destination (e.g.
/// `dayone-moment://ABC`) to the id of an imported media row; returning `None`
/// drops the image. Only imported media is kept — a remote URL would make the
/// editor fetch a third party the moment the entry opens.
///
/// Returns `(yjs_update_v1, content_text, preview_text)` — the two text values
/// are plain (Markdown syntax stripped) so search and previews stay readable.
pub fn build_entry_yjs_from_markdown<F>(
    markdown: &str,
    mut resolve_image: F,
) -> (Vec<u8>, String, String)
where
    F: FnMut(&str) -> Option<String>,
{
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("default");
    let plain = {
        let mut builder = Builder::new(doc.transact_mut(), fragment.clone());

        let mut options = Options::empty();
        options.insert(Options::ENABLE_STRIKETHROUGH);
        options.insert(Options::ENABLE_TASKLISTS);

        for event in Parser::new_ext(markdown, options) {
            match event {
                Event::Start(Tag::Paragraph) => builder.open("paragraph", Vec::new(), true),
                Event::Start(Tag::Heading { level, .. }) => builder.open(
                    "heading",
                    vec![("level", Any::Number(heading_level(level) as f64))],
                    true,
                ),
                Event::Start(Tag::CodeBlock(kind)) => {
                    let attrs = match &kind {
                        CodeBlockKind::Fenced(info) if !info.trim().is_empty() => {
                            let lang = info.split_whitespace().next().unwrap_or("").to_string();
                            vec![("language", Any::String(lang.into()))]
                        }
                        _ => Vec::new(),
                    };
                    builder.open("codeBlock", attrs, true);
                }
                Event::Start(Tag::BlockQuote(_)) => builder.open("blockquote", Vec::new(), false),
                Event::Start(Tag::List(Some(start))) => builder.open(
                    "orderedList",
                    vec![("start", Any::Number(start as f64))],
                    false,
                ),
                Event::Start(Tag::List(None)) => builder.open("bulletList", Vec::new(), false),
                Event::Start(Tag::Item) => builder.open("listItem", Vec::new(), false),
                Event::Start(Tag::Emphasis) => builder.push_mark("italic", empty_map()),
                Event::Start(Tag::Strong) => builder.push_mark("bold", empty_map()),
                Event::Start(Tag::Strikethrough) => builder.push_mark("strike", empty_map()),
                Event::Start(Tag::Link { dest_url, .. }) => {
                    let mut attrs = HashMap::new();
                    attrs.insert(
                        String::from("href"),
                        Any::String(dest_url.to_string().into()),
                    );
                    builder.push_mark("link", Any::Map(Arc::new(attrs)));
                }
                Event::Start(Tag::Image { dest_url, .. }) => {
                    if let Some(media_id) = resolve_image(dest_url.as_ref()) {
                        builder.enqueue_media("image", media_id);
                    }
                    // Alt text is carried by the image node, not the body.
                    builder.skip_text += 1;
                }
                Event::End(TagEnd::Image) => {
                    builder.skip_text = builder.skip_text.saturating_sub(1)
                }
                Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock) => {
                    builder.close_leaf()
                }
                Event::End(TagEnd::BlockQuote(_) | TagEnd::List(_) | TagEnd::Item) => {
                    builder.close_container()
                }
                Event::End(
                    TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link,
                ) => {
                    builder.marks.pop();
                }
                Event::Text(text) => builder.insert_text(text.as_ref(), None),
                Event::Code(text) => builder.insert_text(text.as_ref(), Some("code")),
                // Raw HTML has no schema mapping here — keep the source visible
                // rather than silently dropping content.
                Event::Html(text) | Event::InlineHtml(text) => {
                    builder.insert_text(text.as_ref(), None)
                }
                // Day One writes one line per visual line; CommonMark would fold
                // a single newline into a space, so keep it as a hard break.
                Event::SoftBreak | Event::HardBreak => builder.hard_break(),
                Event::Rule => {
                    builder.open("horizontalRule", Vec::new(), false);
                    builder.materialize();
                    builder.close_container();
                }
                Event::TaskListMarker(checked) => builder.mark_task_item(checked),
                _ => {}
            }
        }

        builder.finish()
    };

    let content_text = plain.trim().to_string();
    let preview_text: String = content_text.chars().take(PREVIEW_MAX_CHARS).collect();
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    (update, content_text, preview_text)
}

/// Max grapheme-ish length for `preview_text` (char count, not bytes).
const PREVIEW_MAX_CHARS: usize = 200;

/// Every mark this converter can emit — see `insert_text`.
/// `underline` and `highlight` are used by the Apple Journal HTML walker.
pub(crate) const MARK_NAMES: [&str; 7] = [
    "bold",
    "italic",
    "strike",
    "code",
    "link",
    "underline",
    "highlight",
];

pub(crate) fn empty_map() -> Any {
    Any::Map(Arc::new(HashMap::new()))
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// A `taskList` may only hold `taskItem`s and a bullet/ordered list only
/// `listItem`s — a list mixing plain and checkbox items would otherwise emit
/// content the editor schema rejects (and y-prosemirror drops on load).
fn coerce_list_item(spec: &mut Spec, parent_tag: &str) {
    match (spec.tag, parent_tag) {
        ("listItem", "taskList") => {
            spec.tag = "taskItem";
            spec.attrs.push(("checked", Any::Bool(false)));
        }
        ("taskItem", "bulletList") | ("taskItem", "orderedList") => {
            spec.tag = "listItem";
            spec.attrs.clear();
        }
        _ => {}
    }
}

#[derive(Clone)]
pub(crate) struct Spec {
    tag: &'static str,
    attrs: Vec<(&'static str, Any)>,
    /// Leaf block that owns an XmlText child (paragraph / heading / codeBlock).
    text_bearing: bool,
    /// Inserted by the builder (tight list items), not by a Markdown Start event.
    auto: bool,
}

pub(crate) struct Builder<'a> {
    txn: TransactionMut<'a>,
    fragment: XmlFragmentRef,
    /// Open element chain, root → leaf. Elements materialise lazily so an
    /// image-only paragraph never leaves an empty node behind.
    stack: Vec<(Spec, Option<XmlElementRef>)>,
    text: Option<XmlTextRef>,
    marks: Vec<(&'static str, Any)>,
    pending_media: Vec<(&'static str, Option<String>)>,
    plain: String,
    skip_text: usize,
}

impl<'a> Builder<'a> {
    pub(crate) fn new(txn: TransactionMut<'a>, fragment: XmlFragmentRef) -> Self {
        Self {
            txn,
            fragment,
            stack: Vec::new(),
            text: None,
            marks: Vec::new(),
            pending_media: Vec::new(),
            plain: String::new(),
            skip_text: 0,
        }
    }

    pub(crate) fn open(
        &mut self,
        tag: &'static str,
        attrs: Vec<(&'static str, Any)>,
        text_bearing: bool,
    ) {
        // A new block ends the implicit paragraph a tight list item opened —
        // otherwise a nested list's text would keep landing in that paragraph.
        self.close_auto_paragraphs();
        self.stack.push((
            Spec {
                tag,
                attrs,
                text_bearing,
                auto: false,
            },
            None,
        ));
    }

    pub(crate) fn push_mark(&mut self, name: &'static str, value: Any) {
        self.marks.push((name, value));
    }

    pub(crate) fn pop_mark(&mut self) {
        self.marks.pop();
    }

    /// Create every not-yet-created element in the open chain.
    pub(crate) fn materialize(&mut self) {
        let mut parent: Option<XmlElementRef> = None;
        for i in 0..self.stack.len() {
            if self.stack[i].1.is_none() {
                let parent_tag = if i == 0 { "" } else { self.stack[i - 1].0.tag };
                coerce_list_item(&mut self.stack[i].0, parent_tag);
                let spec = self.stack[i].0.clone();
                let prelim = XmlElementPrelim::new(spec.tag, []);
                let el = match &parent {
                    Some(p) => p.push_back(&mut self.txn, prelim),
                    None => self.fragment.push_back(&mut self.txn, prelim),
                };
                for (key, value) in spec.attrs {
                    el.insert_attribute(&mut self.txn, key, value);
                }
                self.stack[i].1 = Some(el);
            }
            parent = self.stack[i].1.clone();
        }
    }

    fn current_parent(&self) -> Option<XmlElementRef> {
        self.stack.last().and_then(|(_, el)| el.clone())
    }

    /// Ensure there is an XmlText to append into, opening a paragraph when the
    /// Markdown put inline content straight inside a list item (tight lists).
    fn ensure_text(&mut self) {
        if self.text.is_some() {
            return;
        }
        let has_leaf = self
            .stack
            .last()
            .map(|(spec, _)| spec.text_bearing)
            .unwrap_or(false);
        if !has_leaf {
            self.stack.push((
                Spec {
                    tag: "paragraph",
                    attrs: Vec::new(),
                    text_bearing: true,
                    auto: true,
                },
                None,
            ));
        }
        self.materialize();
        if let Some(el) = self.current_parent() {
            let text = el.push_back(&mut self.txn, XmlTextPrelim::new(""));
            self.text = Some(text);
        }
    }

    pub(crate) fn insert_text(&mut self, value: &str, extra_mark: Option<&'static str>) {
        if self.skip_text > 0 || value.is_empty() {
            return;
        }
        self.ensure_text();
        let Some(text) = self.text.clone() else {
            return;
        };
        // Every known mark is passed explicitly: inserting at the end of a
        // formatted run otherwise inherits that run's formatting.
        let mut attrs: Attrs = MARK_NAMES
            .iter()
            .map(|name| (Arc::from(*name), Any::Null))
            .collect();
        for (name, mark) in &self.marks {
            attrs.insert(Arc::from(*name), mark.clone());
        }
        if let Some(name) = extra_mark {
            attrs.insert(Arc::from(name), empty_map());
        }
        let index = text.len(&self.txn);
        text.insert_with_attributes(&mut self.txn, index, value, attrs);
        self.plain.push_str(value);
    }

    pub(crate) fn hard_break(&mut self) {
        if self.skip_text > 0 {
            return;
        }
        self.ensure_text();
        let Some(el) = self.current_parent() else {
            return;
        };
        el.push_back(&mut self.txn, XmlElementPrelim::new("hardBreak", []));
        // A fresh XmlText child so following text lands after the break.
        let text = el.push_back(&mut self.txn, XmlTextPrelim::new(""));
        self.text = Some(text);
        self.plain.push('\n');
    }

    /// Turn the open `listItem` (and its list, when both are still pending)
    /// into the task-list nodes.
    ///
    /// ponytail: the list tag is decided by its first item — a list mixing
    /// plain and task items renders all items under the first item's list type.
    pub(crate) fn mark_task_item(&mut self, checked: bool) {
        let len = self.stack.len();
        if len == 0 {
            return;
        }
        if let Some((spec, None)) = self.stack.get_mut(len - 1) {
            if spec.tag == "listItem" {
                spec.tag = "taskItem";
                spec.attrs.push(("checked", Any::Bool(checked)));
            }
        }
        if len >= 2 {
            if let Some((spec, None)) = self.stack.get_mut(len - 2) {
                if spec.tag == "bulletList" {
                    spec.tag = "taskList";
                }
            }
        }
    }

    /// Pop the implicit paragraphs opened for tight list items.
    fn close_auto_paragraphs(&mut self) {
        while self
            .stack
            .last()
            .map(|(spec, _)| spec.auto)
            .unwrap_or(false)
        {
            self.close_leaf();
        }
        self.text = None;
    }

    pub(crate) fn close_leaf(&mut self) {
        self.text = None;
        let mut had_content = false;
        if let Some((spec, el)) = self.stack.last() {
            if spec.text_bearing {
                had_content = el.is_some();
                self.stack.pop();
            }
        }
        if had_content {
            self.plain.push('\n');
        }
        self.flush_media();
    }

    pub(crate) fn close_container(&mut self) {
        self.close_auto_paragraphs();
        self.text = None;
        self.stack.pop();
        self.flush_media();
    }

    pub(crate) fn enqueue_media(&mut self, tag: &'static str, media_id: String) {
        self.pending_media.push((tag, Some(media_id)));
    }

    pub(crate) fn enqueue_missing_media(&mut self, tag: &'static str) {
        self.pending_media.push((tag, None));
    }

    pub(crate) fn in_text_block(&self) -> bool {
        self.stack.last().is_some_and(|(spec, _)| spec.text_bearing)
    }

    /// Images / video / audio are top-level blocks in the editor schema, so they
    /// always land as document-level siblings after the block that referenced
    /// them — inside a list item or blockquote they would violate that node's
    /// content rule.
    ///
    /// ponytail: an image referenced from inside a list therefore lands after
    /// the whole list, not between its items.
    pub(crate) fn flush_media(&mut self) {
        for (tag, media_id) in std::mem::take(&mut self.pending_media) {
            let mut attributes = HashMap::new();
            match media_id {
                Some(id) => {
                    attributes.insert(Arc::from("data-media-id"), id);
                }
                None => {
                    attributes.insert(Arc::from("data-media-missing"), String::from("true"));
                }
            }
            // TipTap Image expects `src`; empty string — the editor resolves
            // the file through `data-media-id`, or shows a missing placeholder.
            attributes.insert(Arc::from("src"), String::new());
            let prelim = XmlElementPrelim {
                tag: Arc::from(tag),
                attributes,
                children: Vec::new(),
            };
            self.fragment.push_back(&mut self.txn, prelim);
        }
    }

    pub(crate) fn finish(mut self) -> String {
        self.text = None;
        self.stack.clear();
        self.flush_media();
        self.plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::types::xml::XmlOut;
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, Out, Update};

    fn decode(bytes: &[u8]) -> Doc {
        let update = Update::decode_v1(bytes).expect("decode update");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply update");
        }
        doc
    }

    /// Flatten the fragment into `(tag, text)` pairs, one per top-level node.
    fn top_level(doc: &Doc) -> Vec<(String, String)> {
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        fragment
            .children(&txn)
            .map(|child| match child {
                XmlOut::Element(el) => (el.tag().to_string(), inner_text(&el, &txn)),
                XmlOut::Text(text) => (String::from("#text"), text.get_string(&txn)),
                XmlOut::Fragment(_) => (String::from("#fragment"), String::new()),
            })
            .collect()
    }

    /// Concatenated text of an element's direct XmlText children.
    fn inner_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn) -> String {
        el.children(txn)
            .filter_map(|child| match child {
                XmlOut::Text(text) => Some(text.get_string(txn)),
                _ => None,
            })
            .collect()
    }

    fn attr(doc: &Doc, index: u32, name: &str) -> Option<Out> {
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        match fragment.get(&txn, index)? {
            XmlOut::Element(el) => el.get_attribute(&txn, name),
            _ => None,
        }
    }

    fn build(markdown: &str) -> (Doc, String) {
        let (bytes, content, _) = build_entry_yjs_from_markdown(markdown, |_| None);
        (decode(&bytes), content)
    }

    #[test]
    fn heading_level_is_a_plain_number_not_a_bigint() {
        // `Any::BigInt` decodes to a JS BigInt and TipTap would render every
        // heading as h1 — the encoded attribute must stay `Any::Number`.
        let (doc, _) = build("## Second level");
        assert_eq!(top_level(&doc)[0].0, "heading");
        match attr(&doc, 0, "level") {
            Some(Out::Any(Any::Number(n))) => assert_eq!(n, 2.0),
            other => panic!("expected Any::Number level, got {other:?}"),
        }
    }

    #[test]
    fn inline_marks_are_attribute_maps() {
        let (bytes, content, _) =
            build_entry_yjs_from_markdown("plain **bold** and `code`", |_| None);
        let doc = decode(&bytes);
        assert_eq!(content, "plain bold and code", "content_text is plain");

        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(paragraph) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected paragraph element");
        };
        let XmlOut::Text(text) = paragraph.children(&txn).next().unwrap() else {
            panic!("expected text child");
        };
        let deltas = text.diff(&txn, yrs::types::text::YChange::identity);
        let bold = deltas
            .iter()
            .find(|d| {
                d.attributes
                    .as_ref()
                    .is_some_and(|a| a.contains_key("bold"))
            })
            .expect("a bold run");
        assert_eq!(bold.insert.clone().to_string(&txn), "bold");
        // y-prosemirror rebuilds marks with `schema.mark(name, attrs)` — the
        // value must be a map, never `true`.
        let value = bold.attributes.as_ref().unwrap().get("bold").unwrap();
        assert!(matches!(value, Any::Map(_)), "bold value: {value:?}");
        assert!(
            deltas.iter().any(|d| d
                .attributes
                .as_ref()
                .is_some_and(|a| a.contains_key("code"))),
            "inline code mark present"
        );
    }

    #[test]
    fn fenced_code_block_keeps_newlines_and_language() {
        let (doc, content) = build("```rust\nlet a = 1;\nlet b = 2;\n```");
        let nodes = top_level(&doc);
        assert_eq!(nodes[0].0, "codeBlock");
        assert_eq!(nodes[0].1, "let a = 1;\nlet b = 2;\n");
        assert_eq!(content, "let a = 1;\nlet b = 2;");
        match attr(&doc, 0, "language") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "rust"),
            other => panic!("expected language attribute, got {other:?}"),
        }
    }

    #[test]
    fn single_newline_becomes_a_hard_break_not_a_space() {
        let (doc, content) = build("9/6/26\nSunday, September 6, 2026");
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        assert_eq!(fragment.len(&txn), 1, "one paragraph");
        let XmlOut::Element(paragraph) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected paragraph");
        };
        let has_break = paragraph.children(&txn).any(|child| match child {
            XmlOut::Element(el) => el.tag().as_ref() == "hardBreak",
            _ => false,
        });
        assert!(has_break, "single newline maps to a hardBreak node");
        assert_eq!(content, "9/6/26\nSunday, September 6, 2026");
    }

    #[test]
    fn lists_and_task_items_use_editor_node_names() {
        let (doc, _) = build("- one\n- two\n");
        assert_eq!(top_level(&doc)[0].0, "bulletList");

        let (doc, _) = build("1. one\n2. two\n");
        assert_eq!(top_level(&doc)[0].0, "orderedList");

        let (doc, _) = build("- [x] done\n- [ ] todo\n");
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(list) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected list");
        };
        assert_eq!(list.tag().as_ref(), "taskList");
        let items: Vec<_> = list
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el),
                _ => None,
            })
            .collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].tag().as_ref(), "taskItem");
        assert!(matches!(
            items[0].get_attribute(&txn, "checked"),
            Some(Out::Any(Any::Bool(true)))
        ));
        assert!(matches!(
            items[1].get_attribute(&txn, "checked"),
            Some(Out::Any(Any::Bool(false)))
        ));
    }

    #[test]
    fn image_becomes_a_media_node_and_drops_the_placeholder_text() {
        let (bytes, content, _) =
            build_entry_yjs_from_markdown("before\n\n![](dayone-moment://ABC)\n\nafter", |dest| {
                assert_eq!(dest, "dayone-moment://ABC");
                Some("media-1".to_string())
            });
        let doc = decode(&bytes);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(tags, vec!["paragraph", "image", "paragraph"]);
        assert!(!content.contains("dayone-moment"), "content: {content}");
        match attr(&doc, 1, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "media-1"),
            other => panic!("expected data-media-id, got {other:?}"),
        }
    }

    #[test]
    fn image_only_list_item_keeps_the_image_at_document_level() {
        // `listItem` may not hold an image as its first child — the editor
        // schema would reject the node and y-prosemirror drops it on load.
        let (bytes, content, _) =
            build_entry_yjs_from_markdown("- ![](dayone-moment://ABC)", |_| {
                Some("media-1".to_string())
            });
        let doc = decode(&bytes);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(tags, vec!["image"]);
        assert_eq!(content, "", "no blank line for the dropped paragraph");
    }

    #[test]
    fn mixed_task_and_plain_items_stay_valid_for_the_schema() {
        // taskList holds only taskItems, bulletList only listItems.
        for (markdown, list_tag, item_tags) in [
            (
                "- [ ] task\n- plain\n",
                "taskList",
                ["taskItem", "taskItem"],
            ),
            (
                "- plain\n- [ ] task\n",
                "bulletList",
                ["listItem", "listItem"],
            ),
        ] {
            let (doc, _) = build(markdown);
            let fragment = doc.get_or_insert_xml_fragment("default");
            let txn = doc.transact();
            let XmlOut::Element(list) = fragment.get(&txn, 0).unwrap() else {
                panic!("expected a list for {markdown:?}");
            };
            assert_eq!(list.tag().as_ref(), list_tag, "{markdown:?}");
            let tags: Vec<String> = list
                .children(&txn)
                .filter_map(|child| match child {
                    XmlOut::Element(el) => Some(el.tag().to_string()),
                    _ => None,
                })
                .collect();
            assert_eq!(tags, item_tags, "{markdown:?}");
        }
    }

    #[test]
    fn unresolved_image_leaves_no_empty_paragraph() {
        let (doc, content) = build("![](dayone-moment://MISSING)");
        assert!(top_level(&doc).is_empty(), "no nodes at all");
        assert_eq!(content, "");
    }

    #[test]
    fn escaped_markdown_punctuation_is_unescaped() {
        let (_, content) = build(r"Day One escapes \$1\+1\$ and 1\. lists");
        assert_eq!(content, "Day One escapes $1+1$ and 1. lists");
    }

    #[test]
    fn blockquote_wraps_a_paragraph() {
        let (doc, _) = build("> quoted");
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(quote) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected blockquote");
        };
        assert_eq!(quote.tag().as_ref(), "blockquote");
        let XmlOut::Element(paragraph) = quote.children(&txn).next().unwrap() else {
            panic!("expected paragraph inside blockquote");
        };
        assert_eq!(paragraph.tag().as_ref(), "paragraph");
        assert_eq!(inner_text(&paragraph, &txn), "quoted");
    }

    #[test]
    fn empty_markdown_produces_an_empty_document() {
        let (doc, content) = build("   \n\n");
        assert!(top_level(&doc).is_empty());
        assert_eq!(content, "");
    }

    #[test]
    fn nested_tight_list_keeps_its_own_list_node() {
        let (bytes, content, _) = build_entry_yjs_from_markdown("- parent\n  - child", |_| None);
        let doc = decode(&bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(list) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected bulletList");
        };
        let XmlOut::Element(item) = list.children(&txn).next().unwrap() else {
            panic!("expected listItem");
        };
        let tags: Vec<String> = item
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el.tag().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(tags, vec!["paragraph", "bulletList"]);
        assert_eq!(content, "parent\nchild");
    }

    #[test]
    fn fenced_block_inside_a_tight_list_item_stays_its_own_node() {
        let (doc, content) = build("- item\n\n  ```\n  code\n  ```");
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(list) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected bulletList");
        };
        let XmlOut::Element(item) = list.children(&txn).next().unwrap() else {
            panic!("expected listItem");
        };
        let tags: Vec<String> = item
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el.tag().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(tags, vec!["paragraph", "codeBlock"]);
        assert!(content.contains("code"), "{content}");
    }

    #[test]
    fn split_leading_heading_lifts_a_title_only_from_the_first_line() {
        let (title, body) = split_leading_heading("# My day\n\nBody text");
        assert_eq!(title.as_deref(), Some("My day"));
        assert_eq!(body, "Body text");

        let (title, body) = split_leading_heading("Body first\n\n# Later heading");
        assert_eq!(title, None);
        assert_eq!(body, "Body first\n\n# Later heading");

        // `#tag` is not a heading (no space after the hashes).
        let (title, _) = split_leading_heading("#hashtag line");
        assert_eq!(title, None);

        let (title, _) = split_leading_heading("#\n");
        assert_eq!(title, None);

        // Day One escapes punctuation and may mark up the title line.
        let (title, _) = split_leading_heading("# Ngày 1\\. Thử **nghiệm**\n\nbody");
        assert_eq!(title.as_deref(), Some("Ngày 1. Thử nghiệm"));
    }
}
