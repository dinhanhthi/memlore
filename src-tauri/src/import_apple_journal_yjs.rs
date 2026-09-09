//! Apple Journal HTML → TipTap-compatible Yjs update (walker + CSS allowlist).
//!
//! Drives the shared importer [`crate::import_markdown`] builder so Apple and
//! Markdown imports emit the same XmlFragment `"default"` shape. Semantic tags
//! and an allowlist of Cocoa class / inline CSS (`font-weight`, `font-style`,
//! `text-decoration`, background highlight) become editor marks. Font colour is
//! retained as source metadata with a preserved-only warning — there is no
//! editor colour mark. CSS is not executed and remote resources are never fetched.
//!
//! Provenance lives in a versioned `appleJournalImport` Yjs root map beside
//! fragment `default`. Encoded documents over [`MAX_YJS_DOC_BYTES`] are
//! rejected with [`AppleYjsError::DocumentTooLarge`]; source is never truncated.
//!
//! `rawHtml` in that map is opaque provenance only. It MUST NEVER be rendered
//! as HTML, assigned to `innerHTML`, or loaded via `loadHTMLString` / equivalent
//! WebView APIs. Phase 2+ must treat it as an untrusted byte string for
//! round-trip and audit, not a document to display.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use dom_query::{Document, NodeRef};
use yrs::types::xml::XmlOut;
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, ReadTxn, StateVector, Text, Transact, XmlFragment,
};

use crate::commands::entries::MAX_YJS_DOC_BYTES;
use crate::import_apple_journal::{
    apple_asset_type_from_class, apple_body_needs_recovery, apple_section_inner_html,
    apple_visit_readable_line, classify_local_src, collect_element_declarations,
    extract_non_default_font_color, first_valid_apple_native_location,
    is_fully_mapped_apple_asset_type, is_limited_apple_asset_type, parse_apple_stylesheet,
    resolve_apple_css_marks, AppleConversionKind, AppleConversionWarning, AppleCssMarks,
    AppleCssRule, AppleMapVisit, AppleNativeLocation,
};
use crate::import_markdown::{empty_map, Builder};

/// Yjs root map name stored alongside fragment `"default"`.
pub const APPLE_JOURNAL_IMPORT_ROOT: &str = "appleJournalImport";
/// Provenance schema version written into [`APPLE_JOURNAL_IMPORT_ROOT`].
pub const APPLE_JOURNAL_IMPORT_VERSION: f64 = 1.0;

/// Yjs update plus conversion warnings for one Apple Journal entry.
#[derive(Debug, Clone)]
pub struct AppleEntryYjs {
    pub update: Vec<u8>,
    pub content_text: String,
    pub preview_text: String,
    pub warnings: Vec<AppleConversionWarning>,
}

/// Source metadata persisted in the versioned `appleJournalImport` root map.
///
/// Field values are already-known scan/parse data. Map visits are stored in
/// source order; the first valid visit is also recorded as `native_location`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppleJournalProvenance {
    pub raw_html: String,
    pub sidecars: Vec<AppleJournalSidecarRecord>,
    pub original_relative_names: Vec<String>,
    pub unknown_fields: Vec<AppleJournalUnknownFieldRecord>,
    pub source_dates: Vec<AppleJournalSourceDateRecord>,
    pub resources: Vec<AppleJournalResourceRecord>,
    pub visits: Vec<AppleJournalVisitRecord>,
    pub native_location: Option<AppleNativeLocation>,
}

/// One map visit retained as structured source metadata (not geocoded).
#[derive(Debug, Clone, PartialEq)]
pub struct AppleJournalVisitRecord {
    pub media_src: String,
    pub relative_name: String,
    pub place_name: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub city: Option<String>,
    pub type_of_place: Option<String>,
}

/// One sidecar JSON file retained as raw text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalSidecarRecord {
    pub relative_name: String,
    pub json: String,
}

/// An unknown sidecar key or card field retained for accounting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalUnknownFieldRecord {
    pub relative_name: String,
    pub key: String,
}

/// A raw source date value as it already exists on the parsed structs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalSourceDateRecord {
    pub kind: String,
    pub relative_name: String,
    pub value: String,
}

/// Resource identity: original relative name, content hash, imported media id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalResourceRecord {
    pub relative_name: String,
    pub sha256: String,
    pub media_id: Option<String>,
}

/// Typed failure when an imported Yjs document cannot be persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppleYjsError {
    /// Encoded update exceeds the cap. The source is never truncated.
    DocumentTooLarge { bytes: usize, max_bytes: usize },
}

impl std::fmt::Display for AppleYjsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DocumentTooLarge { bytes, max_bytes } => write!(
                f,
                "Yjs document exceeds maximum allowed size ({max_bytes} bytes), got {bytes}"
            ),
        }
    }
}

impl std::error::Error for AppleYjsError {}

/// Reject encoded documents larger than `max_bytes`. Equality is accepted.
pub(crate) fn enforce_apple_yjs_size(update: &[u8], max_bytes: usize) -> Result<(), AppleYjsError> {
    if update.len() > max_bytes {
        Err(AppleYjsError::DocumentTooLarge {
            bytes: update.len(),
            max_bytes,
        })
    } else {
        Ok(())
    }
}

/// Kind of inline media placeholder the walker can emit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppleMediaKind {
    Image,
    Video,
    Audio,
}

impl AppleMediaKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }
}

/// How a resolved local media `src` should land in the editor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppleMediaResolve {
    /// Bind an inline image/video/audio node to this media id.
    Inline(String),
    /// File exists as an attachment — consume the element, emit no body node.
    Attached,
    /// Local file is missing — keep an inline "media not found" placeholder.
    Missing,
}

impl From<Option<String>> for AppleMediaResolve {
    fn from(value: Option<String>) -> Self {
        match value {
            Some(id) => Self::Inline(id),
            None => Self::Missing,
        }
    }
}

/// Max grapheme-ish length for `preview_text` (char count, not bytes).
const PREVIEW_MAX_CHARS: usize = 200;

/// Convert Apple Journal (or synthetic) HTML into a TipTap Yjs update.
///
/// `resolve_media` maps a local `src` plus kind to [`AppleMediaResolve`].
/// `Option<String>` is accepted (`Some(id)` = inline, `None` = missing
/// placeholder). Remote URLs are not passed to the resolver and are never
/// fetched.
///
/// Returns the Yjs update, plain text, and conversion warnings.
pub fn build_apple_entry_yjs<F, R>(
    html: &str,
    resolve_media: F,
) -> Result<AppleEntryYjs, AppleYjsError>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    build_apple_entry_yjs_with_map_visits(html, resolve_media, &HashMap::new())
}

/// Same as [`build_apple_entry_yjs`], emitting ordered readable visit lines
/// next to each map snapshot whose `src` is in `map_visits`.
pub fn build_apple_entry_yjs_with_map_visits<F, R>(
    html: &str,
    resolve_media: F,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) -> Result<AppleEntryYjs, AppleYjsError>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    reject_source_over_cap(html.len(), MAX_YJS_DOC_BYTES)?;
    let (doc, content_text, warnings) = build_apple_yjs_doc(html, resolve_media, map_visits);
    let built = encode_apple_entry_yjs(doc, content_text, warnings);
    enforce_apple_yjs_size(&built.update, MAX_YJS_DOC_BYTES)?;
    Ok(built)
}

/// Walker plus versioned `appleJournalImport` provenance map.
///
/// Enforces [`MAX_YJS_DOC_BYTES`]. Oversized source is rejected with
/// [`AppleYjsError::DocumentTooLarge`]; the document is never truncated.
pub fn build_apple_entry_yjs_with_provenance<F, R>(
    html: &str,
    resolve_media: F,
    provenance: &AppleJournalProvenance,
) -> Result<AppleEntryYjs, AppleYjsError>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    build_apple_entry_yjs_with_limit(html, resolve_media, provenance, MAX_YJS_DOC_BYTES)
}

/// Same as [`build_apple_entry_yjs_with_provenance`] with an explicit size cap.
///
/// Production always passes [`MAX_YJS_DOC_BYTES`]. Tests may override the cap
/// so at-limit / oversized cases do not allocate a 10 MiB payload.
pub(crate) fn build_apple_entry_yjs_with_limit<F, R>(
    html: &str,
    resolve_media: F,
    provenance: &AppleJournalProvenance,
    max_bytes: usize,
) -> Result<AppleEntryYjs, AppleYjsError>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    reject_source_over_cap(provenance.raw_html.len(), max_bytes)?;
    reject_source_over_cap(html.len(), max_bytes)?;
    let map_visits = map_visits_from_provenance(provenance);
    let (doc, content_text, warnings) = build_apple_yjs_doc(html, resolve_media, &map_visits);
    write_apple_journal_provenance(&doc, provenance);
    let built = encode_apple_entry_yjs(doc, content_text, warnings);
    enforce_apple_yjs_size(&built.update, max_bytes)?;
    Ok(built)
}

fn reject_source_over_cap(bytes: usize, max_bytes: usize) -> Result<(), AppleYjsError> {
    if bytes > max_bytes {
        Err(AppleYjsError::DocumentTooLarge { bytes, max_bytes })
    } else {
        Ok(())
    }
}

fn build_apple_yjs_doc<F, R>(
    html: &str,
    mut resolve_media: F,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) -> (Doc, String, Vec<AppleConversionWarning>)
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    let document = Document::from(html);
    let stylesheet = parse_apple_stylesheet(html);
    // Fixed client id keeps encode size stable for at-limit tests.
    let doc = Doc::with_client_id(1);
    let fragment = doc.get_or_insert_xml_fragment("default");
    let mut warnings = WarningSink::default();
    let inherited = ResolvedStyle::default();
    let plain = {
        let mut builder = Builder::new(doc.transact_mut(), fragment.clone());
        walk_entry(
            html,
            &document,
            &mut builder,
            &mut resolve_media,
            &stylesheet,
            &inherited,
            &mut warnings,
            map_visits,
        );
        builder.finish()
    };
    strip_leading_converted_location(&doc, map_visits);
    normalize_imported_paragraphs(&doc);

    let aliases = location_body_aliases(map_visits);
    let content_text =
        collapse_extra_blank_lines(strip_leading_location_plain(plain.trim(), &aliases).trim());
    (doc, content_text, warnings.warnings)
}

/// Drop imported empty / break-only paragraphs. Apple Journal exports often
/// pad entries with extra blank lines; those must not survive in the editor.
fn normalize_imported_paragraphs(doc: &Doc) {
    let fragment = doc.get_or_insert_xml_fragment("default");
    let drop: Vec<u32> = {
        let txn = doc.transact();
        let n = fragment.len(&txn) as usize;
        (0..n)
            .filter_map(|i| {
                let XmlOut::Element(el) = fragment.get(&txn, i as u32)? else {
                    return None;
                };
                is_blank_imported_paragraph(&el, &txn).then_some(i as u32)
            })
            .collect()
    };
    if drop.is_empty() {
        return;
    }
    let mut txn = doc.transact_mut();
    for index in drop.into_iter().rev() {
        fragment.remove(&mut txn, index);
    }
}

fn is_blank_imported_paragraph(el: &yrs::XmlElementRef, txn: &impl ReadTxn) -> bool {
    if el.tag().as_ref() != "paragraph" {
        return false;
    }
    imported_paragraph_text(el, txn)
        .split_whitespace()
        .next()
        .is_none()
}

fn collapse_extra_blank_lines(text: &str) -> String {
    text.lines()
        .filter(|line| line.split_whitespace().next().is_some())
        .collect::<Vec<_>>()
        .join("\n")
}

fn write_apple_journal_provenance(doc: &Doc, provenance: &AppleJournalProvenance) {
    let map = doc.get_or_insert_map(APPLE_JOURNAL_IMPORT_ROOT);
    let mut txn = doc.transact_mut();
    map.insert(&mut txn, "version", APPLE_JOURNAL_IMPORT_VERSION);
    map.insert(&mut txn, "rawHtml", provenance.raw_html.as_str());

    let sidecars = map.insert(&mut txn, "sidecars", ArrayPrelim::default());
    for sidecar in &provenance.sidecars {
        let rec = sidecars.push_back(&mut txn, MapPrelim::default());
        rec.insert(&mut txn, "relativeName", sidecar.relative_name.as_str());
        rec.insert(&mut txn, "json", sidecar.json.as_str());
    }

    let names = map.insert(&mut txn, "originalRelativeNames", ArrayPrelim::default());
    for name in &provenance.original_relative_names {
        names.push_back(&mut txn, name.as_str());
    }

    let unknown = map.insert(&mut txn, "unknownFields", ArrayPrelim::default());
    for field in &provenance.unknown_fields {
        let rec = unknown.push_back(&mut txn, MapPrelim::default());
        rec.insert(&mut txn, "relativeName", field.relative_name.as_str());
        rec.insert(&mut txn, "key", field.key.as_str());
    }

    let dates = map.insert(&mut txn, "sourceDates", ArrayPrelim::default());
    for date in &provenance.source_dates {
        let rec = dates.push_back(&mut txn, MapPrelim::default());
        rec.insert(&mut txn, "kind", date.kind.as_str());
        rec.insert(&mut txn, "relativeName", date.relative_name.as_str());
        rec.insert(&mut txn, "value", date.value.as_str());
    }

    let resources = map.insert(&mut txn, "resources", MapPrelim::default());
    let mut resource_rows: Vec<&AppleJournalResourceRecord> = provenance.resources.iter().collect();
    resource_rows.sort_by(|a, b| a.relative_name.cmp(&b.relative_name));
    for resource in resource_rows {
        let rec = resources.insert(
            &mut txn,
            resource.relative_name.as_str(),
            MapPrelim::default(),
        );
        rec.insert(&mut txn, "sha256", resource.sha256.as_str());
        rec.insert(
            &mut txn,
            "mediaId",
            resource
                .media_id
                .as_deref()
                .map(Any::from)
                .unwrap_or(Any::Null),
        );
    }

    let visits = map.insert(&mut txn, "visits", ArrayPrelim::default());
    for visit in &provenance.visits {
        let rec = visits.push_back(&mut txn, MapPrelim::default());
        rec.insert(&mut txn, "mediaSrc", visit.media_src.as_str());
        rec.insert(&mut txn, "relativeName", visit.relative_name.as_str());
        rec.insert(&mut txn, "placeName", opt_any_str(&visit.place_name));
        rec.insert(&mut txn, "latitude", opt_any_num(visit.latitude));
        rec.insert(&mut txn, "longitude", opt_any_num(visit.longitude));
        rec.insert(&mut txn, "city", opt_any_str(&visit.city));
        rec.insert(&mut txn, "typeOfPlace", opt_any_str(&visit.type_of_place));
    }

    match &provenance.native_location {
        Some(location) => {
            let rec = map.insert(&mut txn, "nativeLocation", MapPrelim::default());
            rec.insert(&mut txn, "latitude", Any::Number(location.latitude));
            rec.insert(&mut txn, "longitude", Any::Number(location.longitude));
            rec.insert(&mut txn, "label", opt_any_str(&location.label));
            rec.insert(&mut txn, "address", opt_any_str(&location.address));
        }
        None => {
            map.insert(&mut txn, "nativeLocation", Any::Null);
        }
    }
}

fn opt_any_str(value: &Option<String>) -> Any {
    value.as_deref().map(Any::from).unwrap_or(Any::Null)
}

fn opt_any_num(value: Option<f64>) -> Any {
    value.map(Any::Number).unwrap_or(Any::Null)
}

fn map_visits_from_provenance(
    provenance: &AppleJournalProvenance,
) -> HashMap<String, Vec<AppleMapVisit>> {
    let mut index: HashMap<String, Vec<AppleMapVisit>> = HashMap::new();
    for record in &provenance.visits {
        index
            .entry(record.media_src.clone())
            .or_default()
            .push(visit_from_record(record));
    }
    index
}

fn visit_from_record(record: &AppleJournalVisitRecord) -> AppleMapVisit {
    let coordinates_valid = match (record.latitude, record.longitude) {
        (Some(lat), Some(lon)) => (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon),
        _ => false,
    };
    AppleMapVisit {
        place_name: record.place_name.clone(),
        latitude: record.latitude,
        longitude: record.longitude,
        city: record.city.clone(),
        type_of_place: record.type_of_place.clone(),
        coordinates_valid,
    }
}

fn encode_apple_entry_yjs(
    doc: Doc,
    content_text: String,
    warnings: Vec<AppleConversionWarning>,
) -> AppleEntryYjs {
    let preview_text: String = content_text.chars().take(PREVIEW_MAX_CHARS).collect();
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    AppleEntryYjs {
        update,
        content_text,
        preview_text,
        warnings,
    }
}

#[derive(Clone, Default)]
struct ResolvedStyle {
    marks: AppleCssMarks,
    color: Option<String>,
}

#[derive(Default)]
struct WarningSink {
    warnings: Vec<AppleConversionWarning>,
    seen: HashSet<String>,
}

impl WarningSink {
    fn emit(&mut self, warning: AppleConversionWarning) {
        let key = format!(
            "{}:{}",
            warning.feature,
            warning.source_value.as_deref().unwrap_or("")
        );
        if self.seen.insert(key) {
            self.warnings.push(warning);
        }
    }
}

fn walk_entry<F, R>(
    html: &str,
    document: &Document,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    let has_apple_sections =
        document.select(".assetGrid").exists() || document.select(".bodyText").exists();
    if has_apple_sections {
        let recovered_body = if apple_body_needs_recovery(html, document) {
            apple_section_inner_html(html, "bodyText").map(Document::from)
        } else {
            None
        };
        let skip_tree_body = recovered_body.is_some();
        if let Some(body) = document.body() {
            walk_apple_sections(
                &body,
                builder,
                resolve,
                stylesheet,
                inherited,
                warnings,
                map_visits,
                skip_tree_body,
            );
        } else {
            walk_apple_sections(
                &document.root(),
                builder,
                resolve,
                stylesheet,
                inherited,
                warnings,
                map_visits,
                skip_tree_body,
            );
        }
        if let Some(recovered) = recovered_body {
            if let Some(body) = recovered.body() {
                walk_children(
                    &body, builder, resolve, stylesheet, inherited, warnings, map_visits,
                );
            } else {
                walk_children(
                    &recovered.root(),
                    builder,
                    resolve,
                    stylesheet,
                    inherited,
                    warnings,
                    map_visits,
                );
            }
        }
        return;
    }
    if let Some(body) = document.body() {
        walk_children(
            &body, builder, resolve, stylesheet, inherited, warnings, map_visits,
        );
    } else {
        walk_children(
            &document.root(),
            builder,
            resolve,
            stylesheet,
            inherited,
            warnings,
            map_visits,
        );
    }
}

/// Walk `.assetGrid` and `.bodyText` in tree order. Cocoa wraps the document in
/// a repaired `<p>`; emitting that wrapper (or `.pageHeader` / `.title`) would
/// invent paragraphs and leak chrome into the entry body.
fn walk_apple_sections<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
    skip_tree_body: bool,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    if !node.is_element() {
        return;
    }
    let tag = node_name(node);
    if skip_element(node, &tag) {
        return;
    }
    let style = resolve_node_style(node, &tag, stylesheet, inherited);
    if node.has_class("bodyText") {
        if skip_tree_body {
            return;
        }
        walk_children(
            node, builder, resolve, stylesheet, &style, warnings, map_visits,
        );
        return;
    }
    if node.has_class("assetGrid") {
        walk_children(
            node, builder, resolve, stylesheet, &style, warnings, map_visits,
        );
        return;
    }
    for child in node.children() {
        walk_apple_sections(
            &child,
            builder,
            resolve,
            stylesheet,
            &style,
            warnings,
            map_visits,
            skip_tree_body,
        );
    }
}

fn walk_children<F, R>(
    parent: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    for child in parent.children() {
        walk_node(
            &child, builder, resolve, stylesheet, inherited, warnings, map_visits,
        );
    }
}

fn walk_node<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    if node.is_text() {
        emit_text(builder, &node.immediate_text(), inherited, warnings);
        return;
    }
    if !node.is_element() {
        return;
    }

    let tag = node_name(node);
    if skip_element(node, &tag) {
        return;
    }
    if should_skip_converted_location_card(node, map_visits) {
        return;
    }
    let style = resolve_node_style(node, &tag, stylesheet, inherited);
    note_unknown_card(node, warnings);
    if should_skip_mapped_grid_chrome(node) {
        if let Some(src) = emit_first_descendant_media(node, builder, resolve) {
            if let Some(visits) = map_visits.get(&src) {
                emit_map_visit_lines(builder, visits);
            }
        }
        return;
    }
    if let Some(src) = emit_media_element(node, builder, resolve) {
        if let Some(visits) = map_visits.get(&src) {
            emit_map_visit_lines(builder, visits);
        }
        return;
    }

    match tag.as_str() {
        "br" => builder.hard_break(),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = tag.as_bytes()[1] - b'0';
            builder.open(
                "heading",
                vec![("level", Any::Number(f64::from(level)))],
                true,
            );
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_leaf();
        }
        "p" => {
            if should_skip_converted_location_paragraph(node, map_visits) {
                return;
            }
            builder.open("paragraph", Vec::new(), true);
            builder.materialize();
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_leaf();
        }
        "blockquote" => {
            builder.open("blockquote", Vec::new(), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "pre" => {
            builder.open("codeBlock", code_block_attrs(node), true);
            let mut raw = String::new();
            collect_raw_text(node, &mut raw);
            emit_text(builder, &raw, &style, warnings);
            builder.close_leaf();
        }
        "ul" => {
            builder.open("bulletList", Vec::new(), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "ol" => {
            builder.open("orderedList", ordered_list_attrs(node), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "li" => {
            builder.open("listItem", Vec::new(), false);
            if let Some(checked) = list_item_checked(node) {
                builder.mark_task_item(checked);
            }
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "table" => {
            builder.open("table", Vec::new(), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "thead" | "tbody" | "tfoot" | "colgroup" | "col" => {
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
        }
        "tr" => {
            builder.open("tableRow", Vec::new(), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "th" => {
            builder.open("tableHeader", table_cell_attrs(node), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "td" => {
            builder.open("tableCell", table_cell_attrs(node), false);
            walk_children(
                node, builder, resolve, stylesheet, &style, warnings, map_visits,
            );
            builder.close_container();
        }
        "strong" | "b" => walk_marked(
            node, builder, resolve, stylesheet, &style, warnings, map_visits, "bold",
        ),
        "em" | "i" => walk_marked(
            node, builder, resolve, stylesheet, &style, warnings, map_visits, "italic",
        ),
        "u" => walk_marked(
            node,
            builder,
            resolve,
            stylesheet,
            &style,
            warnings,
            map_visits,
            "underline",
        ),
        "s" | "strike" | "del" => walk_marked(
            node, builder, resolve, stylesheet, &style, warnings, map_visits, "strike",
        ),
        "mark" => walk_marked(
            node,
            builder,
            resolve,
            stylesheet,
            &style,
            warnings,
            map_visits,
            "highlight",
        ),
        "code" => walk_marked(
            node, builder, resolve, stylesheet, &style, warnings, map_visits, "code",
        ),
        "a" => walk_link(
            node, builder, resolve, stylesheet, &style, warnings, map_visits,
        ),
        "input" => {}
        _ => walk_children(
            node, builder, resolve, stylesheet, &style, warnings, map_visits,
        ),
    }
}

fn walk_marked<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
    mark: &'static str,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    builder.push_mark(mark, empty_map());
    walk_children(
        node, builder, resolve, stylesheet, inherited, warnings, map_visits,
    );
    builder.pop_mark();
}

fn walk_link<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
    stylesheet: &[AppleCssRule],
    inherited: &ResolvedStyle,
    warnings: &mut WarningSink,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    if let Some(href) = node.attr("href") {
        if let Some(safe) = safe_href(&href) {
            let mut attrs = HashMap::new();
            attrs.insert(String::from("href"), Any::String(safe.to_string().into()));
            builder.push_mark("link", Any::Map(Arc::new(attrs)));
            walk_children(
                node, builder, resolve, stylesheet, inherited, warnings, map_visits,
            );
            builder.pop_mark();
            return;
        }
    }
    walk_children(
        node, builder, resolve, stylesheet, inherited, warnings, map_visits,
    );
}

fn emit_text(
    builder: &mut Builder<'_>,
    text: &str,
    style: &ResolvedStyle,
    warnings: &mut WarningSink,
) {
    if text.is_empty() {
        return;
    }
    if !builder.in_text_block() && text.chars().all(char::is_whitespace) {
        return;
    }
    if let Some(color) = &style.color {
        // TODO(later): native editor colour mark — see docs/LATER.md
        warnings.emit(AppleConversionWarning {
            kind: AppleConversionKind::PreservedOnly,
            feature: String::from("font-color"),
            message: String::from(
                "Journal font colour is retained in source metadata only; Memlore has no editor colour mark",
            ),
            source_value: Some(color.clone()),
        });
    }
    let mut pushed = 0;
    pushed += push_css_mark(builder, style.marks.bold, "bold");
    pushed += push_css_mark(builder, style.marks.italic, "italic");
    pushed += push_css_mark(builder, style.marks.underline, "underline");
    pushed += push_css_mark(builder, style.marks.strike, "strike");
    pushed += push_css_mark(builder, style.marks.highlight, "highlight");
    builder.insert_text(text, None);
    for _ in 0..pushed {
        builder.pop_mark();
    }
}

fn push_css_mark(builder: &mut Builder<'_>, enabled: Option<bool>, name: &'static str) -> usize {
    if enabled == Some(true) {
        builder.push_mark(name, empty_map());
        1
    } else {
        0
    }
}

fn resolve_node_style(
    node: &NodeRef<'_>,
    tag: &str,
    stylesheet: &[AppleCssRule],
    parent: &ResolvedStyle,
) -> ResolvedStyle {
    let classes = class_list(node);
    let inline = node.attr("style").map(|value| value.to_string());
    let decls = collect_element_declarations(stylesheet, tag, &classes, inline.as_deref());
    let local = resolve_apple_css_marks(&decls);
    let color = if css_has_color(&decls) {
        extract_non_default_font_color(&decls)
    } else {
        parent.color.clone()
    };
    ResolvedStyle {
        marks: AppleCssMarks::merge_inherited(parent.marks, local),
        color,
    }
}

fn css_has_color(decls: &[(String, String)]) -> bool {
    decls
        .iter()
        .any(|(prop, _)| prop.eq_ignore_ascii_case("color"))
}

fn class_list(node: &NodeRef<'_>) -> Vec<String> {
    node.attr("class")
        .map(|value| {
            value
                .split_whitespace()
                .filter(|part| !part.is_empty())
                .map(|part| part.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn note_unknown_card(node: &NodeRef<'_>, warnings: &mut WarningSink) {
    let Some(class_attr) = node.attr("class") else {
        return;
    };
    let Some(asset_type) = apple_asset_type_from_class(&class_attr) else {
        return;
    };
    if is_fully_mapped_apple_asset_type(&asset_type) {
        return;
    }
    if is_limited_apple_asset_type(&asset_type) {
        warnings.emit(AppleConversionWarning {
            kind: AppleConversionKind::Limitation,
            feature: format!("asset-type:{asset_type}"),
            message: format!(
                "'{asset_type}' is not a native editor node; visible text and media position were kept"
            ),
            source_value: Some(asset_type),
        });
        return;
    }
    warnings.emit(AppleConversionWarning {
        kind: AppleConversionKind::Limitation,
        feature: format!("unknown-card:{asset_type}"),
        message: format!(
            "Unknown card '{asset_type}' has no native editor node; visible text was kept"
        ),
        source_value: Some(asset_type),
    });
}

fn emit_media_element<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
) -> Option<String>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    let kind = match node_name(node).as_str() {
        "img" => AppleMediaKind::Image,
        "video" => AppleMediaKind::Video,
        "audio" => AppleMediaKind::Audio,
        _ => return None,
    };
    let Some(src) = media_src(node, kind) else {
        return Some(String::new());
    };
    if classify_local_src(&src).is_err() {
        return Some(src);
    }
    match resolve(kind, &src).into() {
        AppleMediaResolve::Inline(media_id) => builder.enqueue_media(kind.tag(), media_id),
        AppleMediaResolve::Missing => builder.enqueue_missing_media(kind.tag()),
        AppleMediaResolve::Attached => {}
    }
    if !builder.in_text_block() {
        builder.flush_media();
    }
    Some(src)
}

fn should_skip_mapped_grid_chrome(node: &NodeRef<'_>) -> bool {
    if !node.has_class("gridItem") {
        return false;
    }
    node.attr("class")
        .and_then(|class_attr| apple_asset_type_from_class(&class_attr))
        .is_some_and(|asset| is_fully_mapped_apple_asset_type(&asset))
}

fn emit_first_descendant_media<F, R>(
    node: &NodeRef<'_>,
    builder: &mut Builder<'_>,
    resolve: &mut F,
) -> Option<String>
where
    F: FnMut(AppleMediaKind, &str) -> R,
    R: Into<AppleMediaResolve>,
{
    if let Some(src) = emit_media_element(node, builder, resolve) {
        return Some(src);
    }
    for child in node.children() {
        if let Some(src) = emit_first_descendant_media(&child, builder, resolve) {
            return Some(src);
        }
    }
    None
}

fn emit_map_visit_lines(builder: &mut Builder<'_>, visits: &[AppleMapVisit]) {
    if visits.is_empty() {
        return;
    }
    let native = first_valid_apple_native_location(visits);
    builder.flush_media();
    for visit in visits {
        if visit_is_native_location(visit, native.as_ref()) {
            continue;
        }
        let Some(line) = apple_visit_readable_line(visit) else {
            continue;
        };
        builder.open("paragraph", Vec::new(), true);
        builder.materialize();
        builder.insert_text(&line, None);
        builder.close_leaf();
    }
}

fn visit_is_native_location(visit: &AppleMapVisit, native: Option<&AppleNativeLocation>) -> bool {
    let Some(native) = native else {
        return false;
    };
    match (visit.latitude, visit.longitude) {
        (Some(lat), Some(lon)) => lat == native.latitude && lon == native.longitude,
        _ => false,
    }
}

fn location_body_aliases(map_visits: &HashMap<String, Vec<AppleMapVisit>>) -> HashSet<String> {
    let mut aliases = HashSet::new();
    for visits in map_visits.values() {
        let Some(native) = first_valid_apple_native_location(visits) else {
            continue;
        };
        if let Some(label) = &native.label {
            aliases.insert(normalize_location_alias(label));
        }
        match (&native.label, &native.address) {
            (Some(label), Some(address)) => {
                aliases.insert(normalize_location_alias(&format!("{label}, {address}")));
            }
            (None, Some(address)) => {
                aliases.insert(normalize_location_alias(address));
            }
            _ => {}
        }
    }
    aliases.retain(|alias| !alias.is_empty());
    aliases
}

fn normalize_location_alias(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn text_matches_location_alias(text: &str, aliases: &HashSet<String>) -> bool {
    let normalized = normalize_location_alias(text);
    !normalized.is_empty() && aliases.contains(&normalized)
}

fn should_skip_converted_location_paragraph(
    node: &NodeRef<'_>,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) -> bool {
    let aliases = location_body_aliases(map_visits);
    if aliases.is_empty() {
        return false;
    }
    let mut visible = String::new();
    collect_raw_text(node, &mut visible);
    text_matches_location_alias(&visible, &aliases)
}

fn strip_leading_location_plain(text: &str, aliases: &HashSet<String>) -> String {
    if aliases.is_empty() {
        return text.to_string();
    }
    let mut lines: Vec<&str> = text.lines().collect();
    while let Some(first) = lines.first() {
        if first.trim().is_empty() || text_matches_location_alias(first, aliases) {
            lines.remove(0);
            continue;
        }
        break;
    }
    lines.join("\n")
}

fn should_skip_converted_location_card(
    node: &NodeRef<'_>,
    map_visits: &HashMap<String, Vec<AppleMapVisit>>,
) -> bool {
    if !node.has_class("gridItem") {
        return false;
    }
    let Some(asset) = node
        .attr("class")
        .and_then(|class_attr| apple_asset_type_from_class(&class_attr))
    else {
        return false;
    };
    if asset != "location" {
        return false;
    }
    let aliases = location_body_aliases(map_visits);
    if aliases.is_empty() {
        return false;
    }
    let mut visible = String::new();
    collect_raw_text(node, &mut visible);
    let normalized = normalize_location_alias(&visible);
    normalized.is_empty() || aliases.contains(&normalized)
}

fn strip_leading_converted_location(doc: &Doc, map_visits: &HashMap<String, Vec<AppleMapVisit>>) {
    let aliases = location_body_aliases(map_visits);
    if aliases.is_empty() {
        return;
    }
    let fragment = doc.get_or_insert_xml_fragment("default");
    let drop: Vec<u32> = {
        let txn = doc.transact();
        let n = fragment.len(&txn) as usize;
        let mut drop = Vec::new();
        for i in 0..n {
            let Some(XmlOut::Element(el)) = fragment.get(&txn, i as u32) else {
                break;
            };
            if el.tag().as_ref() != "paragraph" {
                break;
            }
            let text = imported_paragraph_text(&el, &txn);
            if text_matches_location_alias(&text, &aliases)
                || is_blank_imported_paragraph(&el, &txn)
            {
                drop.push(i as u32);
                continue;
            }
            break;
        }
        drop
    };
    if drop.is_empty() {
        return;
    }
    let mut txn = doc.transact_mut();
    for index in drop.into_iter().rev() {
        fragment.remove(&mut txn, index);
    }
}

fn imported_paragraph_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn) -> String {
    let mut out = String::new();
    collect_imported_text(el, txn, &mut out);
    out
}

fn collect_imported_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn, out: &mut String) {
    for child in el.children(txn) {
        match child {
            XmlOut::Text(text) => out.push_str(&xml_text_plain(&text, txn)),
            XmlOut::Element(child) => {
                if child.tag().as_ref() == "hardBreak" {
                    out.push('\n');
                } else if matches!(child.tag().as_ref(), "image" | "video" | "audio") {
                    out.push('\u{FFFC}');
                } else {
                    collect_imported_text(&child, txn, out);
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }
}

fn xml_text_plain(text: &yrs::XmlTextRef, txn: &impl ReadTxn) -> String {
    text.diff(txn, yrs::types::text::YChange::identity)
        .into_iter()
        .map(|delta| delta.insert.to_string(txn))
        .collect()
}

fn media_src(node: &NodeRef<'_>, kind: AppleMediaKind) -> Option<String> {
    if let Some(src) = nonempty_attr(node, "src") {
        return Some(src);
    }
    if matches!(kind, AppleMediaKind::Video | AppleMediaKind::Audio) {
        for child in node.children() {
            if node_name(&child) == "source" {
                if let Some(src) = nonempty_attr(&child, "src") {
                    return Some(src);
                }
            }
        }
    }
    None
}

fn nonempty_attr(node: &NodeRef<'_>, name: &str) -> Option<String> {
    let value = node.attr(name)?.to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn skip_element(node: &NodeRef<'_>, tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "head" | "noscript" | "template" | "iframe" | "object" | "embed"
    ) || node.has_class("pageHeader")
        || node.has_class("title")
}

fn node_name(node: &NodeRef<'_>) -> String {
    node.node_name()
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default()
}

fn collect_raw_text(node: &NodeRef<'_>, out: &mut String) {
    if node.is_text() {
        out.push_str(&node.immediate_text());
        return;
    }
    if !node.is_element() {
        return;
    }
    let tag = node_name(node);
    if matches!(tag.as_str(), "script" | "style") {
        return;
    }
    if tag == "br" {
        out.push('\n');
        return;
    }
    for child in node.children() {
        collect_raw_text(&child, out);
    }
}

fn code_block_attrs(node: &NodeRef<'_>) -> Vec<(&'static str, Any)> {
    match fence_language(node) {
        Some(lang) => vec![("language", Any::String(lang.into()))],
        None => Vec::new(),
    }
}

fn fence_language(node: &NodeRef<'_>) -> Option<String> {
    if let Some(lang) = language_from_class(node) {
        return Some(lang);
    }
    for child in node.element_children() {
        if node_name(&child) == "code" {
            if let Some(lang) = language_from_class(&child) {
                return Some(lang);
            }
        }
    }
    None
}

fn language_from_class(node: &NodeRef<'_>) -> Option<String> {
    let class = node.attr("class")?;
    class
        .split_whitespace()
        .find_map(|part| part.strip_prefix("language-"))
        .filter(|lang| !lang.is_empty())
        .map(|lang| lang.to_string())
}

fn ordered_list_attrs(node: &NodeRef<'_>) -> Vec<(&'static str, Any)> {
    let start = nonempty_attr(node, "start")
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0);
    vec![("start", Any::Number(start))]
}

fn table_cell_attrs(node: &NodeRef<'_>) -> Vec<(&'static str, Any)> {
    let mut attrs = Vec::new();
    if let Some(n) = number_attr(node, "colspan") {
        attrs.push(("colspan", Any::Number(n)));
    }
    if let Some(n) = number_attr(node, "rowspan") {
        attrs.push(("rowspan", Any::Number(n)));
    }
    attrs
}

fn number_attr(node: &NodeRef<'_>, name: &str) -> Option<f64> {
    nonempty_attr(node, name)?
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
}

fn list_item_checked(node: &NodeRef<'_>) -> Option<bool> {
    if node
        .attr("data-type")
        .is_some_and(|value| value.eq_ignore_ascii_case("taskItem"))
    {
        let checked = node.attr("data-checked").is_some_and(|value| {
            value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("checked")
        });
        return Some(checked);
    }
    find_checkbox(node)
}

fn find_checkbox(node: &NodeRef<'_>) -> Option<bool> {
    if is_checkbox(node) {
        return Some(checkbox_checked(node));
    }
    for child in node.children() {
        if let Some(checked) = find_checkbox(&child) {
            return Some(checked);
        }
    }
    None
}

fn is_checkbox(node: &NodeRef<'_>) -> bool {
    node_name(node) == "input"
        && node
            .attr("type")
            .is_some_and(|value| value.eq_ignore_ascii_case("checkbox"))
}

fn checkbox_checked(node: &NodeRef<'_>) -> bool {
    node.has_attr("checked")
        && node
            .attr("checked")
            .is_none_or(|value| !value.eq_ignore_ascii_case("false"))
}

fn safe_href(href: &str) -> Option<&str> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    let scheme = href.split(':').next().unwrap_or("");
    if href.as_bytes().get(scheme.len()) == Some(&b':') {
        match scheme.to_ascii_lowercase().as_str() {
            "http" | "https" | "mailto" | "tel" => Some(href),
            _ => None,
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_apple_journal::parse_apple_resource_metadata;
    use yrs::types::xml::XmlOut;
    use yrs::updates::decoder::Decode;
    use yrs::{Any, Doc, GetString, Map, Out, ReadTxn, Text, Transact, Update, Xml, XmlFragment};

    fn decode(bytes: &[u8]) -> Doc {
        let update = Update::decode_v1(bytes).expect("decode update");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply update");
        }
        doc
    }

    fn build_ok<F, R>(html: &str, resolve: F) -> AppleEntryYjs
    where
        F: FnMut(AppleMediaKind, &str) -> R,
        R: Into<AppleMediaResolve>,
    {
        build_apple_entry_yjs(html, resolve).expect("yjs under cap")
    }

    fn build(html: &str) -> (Doc, String) {
        let built = build_ok(html, |_, _| None);
        (decode(&built.update), built.content_text)
    }

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

    fn inner_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn) -> String {
        el.children(txn)
            .filter_map(|child| match child {
                XmlOut::Text(text) => Some(text.get_string(txn)),
                _ => None,
            })
            .collect()
    }

    fn collected_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn) -> String {
        let mut out = String::new();
        collect_text(el, txn, &mut out);
        out
    }

    fn collect_text(el: &yrs::XmlElementRef, txn: &impl ReadTxn, out: &mut String) {
        for child in el.children(txn) {
            match child {
                XmlOut::Text(text) => out.push_str(&text.get_string(txn)),
                XmlOut::Element(child) => collect_text(&child, txn, out),
                XmlOut::Fragment(_) => {}
            }
        }
    }

    fn fragment_el(doc: &Doc, index: u32) -> yrs::XmlElementRef {
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        match fragment.get(&txn, index).expect("node at index") {
            XmlOut::Element(el) => el,
            other => panic!("expected element at {index}, got {other:?}"),
        }
    }

    fn attr(doc: &Doc, index: u32, name: &str) -> Option<Out> {
        let el = fragment_el(doc, index);
        let txn = doc.transact();
        el.get_attribute(&txn, name)
    }

    fn paragraph_deltas(doc: &Doc, index: u32) -> Vec<(String, Vec<String>)> {
        let el = fragment_el(doc, index);
        let txn = doc.transact();
        assert_eq!(el.tag().as_ref(), "paragraph");
        let XmlOut::Text(text) = el
            .children(&txn)
            .find(|child| matches!(child, XmlOut::Text(_)))
            .expect("text child")
        else {
            panic!("expected text child");
        };
        text.diff(&txn, yrs::types::text::YChange::identity)
            .into_iter()
            .map(|delta| {
                let insert = delta.insert.clone().to_string(&txn);
                let marks = delta
                    .attributes
                    .as_ref()
                    .map(|attrs| {
                        let mut names: Vec<String> = attrs
                            .iter()
                            .filter(|(_, value)| !matches!(value, Any::Null))
                            .map(|(name, _)| name.to_string())
                            .collect();
                        names.sort();
                        names
                    })
                    .unwrap_or_default();
                (insert, marks)
            })
            .collect()
    }

    fn mark_value<'a>(doc: &'a Doc, index: u32, mark: &str) -> Any {
        let el = fragment_el(doc, index);
        let txn = doc.transact();
        let XmlOut::Text(text) = el.children(&txn).next().expect("text") else {
            panic!("expected text");
        };
        let deltas = text.diff(&txn, yrs::types::text::YChange::identity);
        let run = deltas
            .iter()
            .find(|d| {
                d.attributes.as_ref().is_some_and(|a| {
                    a.contains_key(mark) && !matches!(a.get(mark), Some(Any::Null))
                })
            })
            .unwrap_or_else(|| panic!("missing mark {mark}"));
        run.attributes.as_ref().unwrap().get(mark).unwrap().clone()
    }

    #[test]
    fn paragraphs_preserve_text_order() {
        let (doc, content) = build("<p>alpha</p><p>bravo</p>");
        let nodes = top_level(&doc);
        assert_eq!(
            nodes,
            vec![
                ("paragraph".into(), "alpha".into()),
                ("paragraph".into(), "bravo".into())
            ]
        );
        assert_eq!(content, "alpha\nbravo");
    }

    #[test]
    fn hard_break_stays_inside_one_paragraph() {
        let (doc, content) = build("<p>one<br>two</p>");
        let nodes = top_level(&doc);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].0, "paragraph");
        let el = fragment_el(&doc, 0);
        let txn = doc.transact();
        let tags: Vec<String> = el
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(child) => Some(child.tag().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(tags, vec!["hardBreak"]);
        assert_eq!(content, "one\ntwo");
    }

    #[test]
    fn empty_paragraphs_between_blocks_are_dropped() {
        let (doc, content) = build("<p>before</p><p></p><p>after</p>");
        assert_eq!(
            top_level(&doc),
            vec![
                ("paragraph".into(), "before".into()),
                ("paragraph".into(), "after".into())
            ],
            "Apple Journal empty lines must not survive as editor paragraphs"
        );
        assert_eq!(content, "before\nafter");
    }

    #[test]
    fn consecutive_empty_paragraphs_are_dropped() {
        let (doc, content) = build("<p>before</p><p></p><p></p><p></p><p>after</p>");
        assert_eq!(
            top_level(&doc),
            vec![
                ("paragraph".into(), "before".into()),
                ("paragraph".into(), "after".into())
            ],
            "runs of empty <p> must be removed, not kept as a blank: {doc_nodes:?}",
            doc_nodes = top_level(&doc)
        );
        assert_eq!(content, "before\nafter");
    }

    #[test]
    fn leading_and_trailing_empty_paragraphs_are_dropped() {
        let (doc, content) = build("<p></p><p>keep</p><p></p>");
        assert_eq!(
            top_level(&doc),
            vec![("paragraph".into(), "keep".into())],
            "leading/trailing empty <p> must not stay in the editor"
        );
        assert_eq!(content, "keep");
    }

    #[test]
    fn break_only_paragraphs_are_dropped() {
        let (doc, content) = build("<p>before</p><p><br></p><p><br><br></p><p>after</p>");
        assert_eq!(
            top_level(&doc),
            vec![
                ("paragraph".into(), "before".into()),
                ("paragraph".into(), "after".into())
            ],
            "<p><br></p> is an empty line and must be removed: {doc_nodes:?}",
            doc_nodes = top_level(&doc)
        );
        assert_eq!(content, "before\nafter");
    }

    #[test]
    fn apple_body_empty_lines_are_dropped() {
        let (doc, content) = build(
            r#"<div class="bodyText">
                <p>Chuyến đi của cha mẹ mình.</p>
                <p><br></p>
                <p><br></p>
                <p>&nbsp;</p>
                <p>Đợt này sang mới thấy.</p>
            </div>"#,
        );
        assert_eq!(
            top_level(&doc),
            vec![
                ("paragraph".into(), "Chuyến đi của cha mẹ mình.".into()),
                ("paragraph".into(), "Đợt này sang mới thấy.".into())
            ]
        );
        assert_eq!(
            content,
            "Chuyến đi của cha mẹ mình.\nĐợt này sang mới thấy."
        );
    }

    #[test]
    fn heading_level_is_a_plain_number_not_a_bigint() {
        let (doc, content) = build("<h2>Second</h2>");
        assert_eq!(top_level(&doc)[0].0, "heading");
        assert_eq!(content, "Second");
        match attr(&doc, 0, "level") {
            Some(Out::Any(Any::Number(n))) => assert_eq!(n, 2.0),
            other => panic!("expected Any::Number level, got {other:?}"),
        }
    }

    #[test]
    fn semantic_marks_use_attribute_maps() {
        let (doc, content) = build(
            "<p>plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> <mark>hi</mark></p>",
        );
        assert_eq!(content, "plain bold italic under strike hi");
        let deltas = paragraph_deltas(&doc, 0);
        let expected = [
            ("bold", "bold"),
            ("italic", "italic"),
            ("underline", "under"),
            ("strike", "strike"),
            ("highlight", "hi"),
        ];
        for (mark, text) in expected {
            let run = deltas
                .iter()
                .find(|(insert, marks)| insert == text && marks.iter().any(|m| m == mark))
                .unwrap_or_else(|| panic!("missing {mark} run for {text:?}: {deltas:?}"));
            assert_eq!(run.1, vec![mark.to_string()]);
            let value = mark_value(&doc, 0, mark);
            assert!(matches!(value, Any::Map(_)), "{mark} value: {value:?}");
        }
    }

    #[test]
    fn safe_https_link_is_a_mark() {
        let (doc, content) = build(r#"<p><a href="https://example.com/path">ex</a></p>"#);
        assert_eq!(content, "ex");
        let value = mark_value(&doc, 0, "link");
        let Any::Map(map) = value else {
            panic!("link value must be a map");
        };
        match map.get("href") {
            Some(Any::String(s)) => assert_eq!(s.as_ref(), "https://example.com/path"),
            other => panic!("expected href string, got {other:?}"),
        }
    }

    #[test]
    fn javascript_link_is_inert_plain_text() {
        let (doc, content) = build(r#"<p><a href="javascript:alert(1)">danger</a></p>"#);
        assert_eq!(content, "danger");
        let deltas = paragraph_deltas(&doc, 0);
        assert!(
            deltas
                .iter()
                .all(|(_, marks)| !marks.iter().any(|m| m == "link")),
            "javascript: must not become a link mark: {deltas:?}"
        );
    }

    #[test]
    fn nested_lists_keep_child_list_nodes() {
        let (doc, content) = build("<ul><li>parent<ul><li>child</li></ul></li></ul>");
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(list) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected bulletList");
        };
        assert_eq!(list.tag().as_ref(), "bulletList");
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
    fn task_list_items_use_editor_node_names() {
        let (doc, _) = build(
            r#"<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul>"#,
        );
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
    fn ordered_list_start_is_a_plain_number() {
        let (doc, _) = build(r#"<ol start="3"><li>three</li></ol>"#);
        assert_eq!(top_level(&doc)[0].0, "orderedList");
        match attr(&doc, 0, "start") {
            Some(Out::Any(Any::Number(n))) => assert_eq!(n, 3.0),
            other => panic!("expected Any::Number start, got {other:?}"),
        }
    }

    #[test]
    fn blockquote_wraps_a_paragraph() {
        let (doc, _) = build("<blockquote>quoted</blockquote>");
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
    fn pre_code_becomes_a_code_block() {
        let (doc, content) = build("<pre><code class=\"language-rust\">let a = 1;\n</code></pre>");
        let nodes = top_level(&doc);
        assert_eq!(nodes[0].0, "codeBlock");
        assert!(nodes[0].1.contains("let a = 1;"), "{}", nodes[0].1);
        assert!(content.contains("let a = 1;"), "{content}");
        match attr(&doc, 0, "language") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "rust"),
            other => panic!("expected language attribute, got {other:?}"),
        }
    }

    #[test]
    fn inline_code_is_a_mark() {
        let (doc, content) = build("<p>use <code>code</code></p>");
        assert_eq!(content, "use code");
        let value = mark_value(&doc, 0, "code");
        assert!(matches!(value, Any::Map(_)), "code value: {value:?}");
    }

    #[test]
    fn table_uses_tiptap_node_names() {
        let (doc, content) = build(
            "<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>",
        );
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(table) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected table");
        };
        assert_eq!(table.tag().as_ref(), "table");
        let rows: Vec<_> = table
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el),
                _ => None,
            })
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.tag().as_ref() == "tableRow"));
        let header_tags: Vec<String> = rows[0]
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el.tag().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(header_tags, vec!["tableHeader", "tableHeader"]);
        let cell_tags: Vec<String> = rows[1]
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) => Some(el.tag().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(cell_tags, vec!["tableCell", "tableCell"]);
        assert_eq!(collected_text(&table, &txn).replace('\n', ""), "H1H2AB");
        assert!(content.contains("H1"), "{content}");
        assert!(content.contains("A"), "{content}");
    }

    #[test]
    fn table_colspan_is_a_plain_number() {
        let (doc, _) = build(r#"<table><tr><td colspan="2">wide</td></tr></table>"#);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        let XmlOut::Element(table) = fragment.get(&txn, 0).unwrap() else {
            panic!("expected table");
        };
        let XmlOut::Element(row) = table.children(&txn).next().unwrap() else {
            panic!("expected row");
        };
        let XmlOut::Element(cell) = row.children(&txn).next().unwrap() else {
            panic!("expected cell");
        };
        match cell.get_attribute(&txn, "colspan") {
            Some(Out::Any(Any::Number(n))) => assert_eq!(n, 2.0),
            other => panic!("expected Any::Number colspan, got {other:?}"),
        }
    }

    #[test]
    fn ordered_media_placeholders_use_data_media_id() {
        let built = build_ok(
            r#"<p>before</p><img src="photo.jpg"><video><source src="clip.mov"></video><audio src="memo.m4a"></audio><p>after</p>"#,
            |kind, src| match (kind, src) {
                (AppleMediaKind::Image, "photo.jpg") => Some("1".into()),
                (AppleMediaKind::Video, "clip.mov") => Some("2".into()),
                (AppleMediaKind::Audio, "memo.m4a") => Some("3".into()),
                other => panic!("unexpected resolve {other:?}"),
            },
        );
        let doc = decode(&built.update);
        let content = built.content_text;
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(
            tags,
            vec!["paragraph", "image", "video", "audio", "paragraph"]
        );
        assert_eq!(content, "before\nafter");
        for (index, id) in [(1u32, "1"), (2, "2"), (3, "3")] {
            match attr(&doc, index, "data-media-id") {
                Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), id),
                other => panic!("expected data-media-id at {index}, got {other:?}"),
            }
        }
    }

    #[test]
    fn attached_local_media_leaves_no_body_node() {
        let built = build_ok(
            r#"<p>before</p><img src="../Resources/photo.jpg"><p>after</p>"#,
            |_, _| AppleMediaResolve::Attached,
        );
        let doc = decode(&built.update);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(
            tags,
            vec!["paragraph", "paragraph"],
            "attached media must not become an editor node: {tags:?}"
        );
        assert_eq!(built.content_text, "before\nafter");
    }

    #[test]
    fn unresolved_local_media_is_a_missing_placeholder() {
        let built = build_ok(
            r#"<p>before</p><img src="../Resources/absent.jpg"><p>after</p>"#,
            |_, _| None,
        );
        let doc = decode(&built.update);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(
            tags,
            vec!["paragraph", "image", "paragraph"],
            "missing local media must keep its inline slot: {tags:?}"
        );
        assert!(
            attr(&doc, 1, "data-media-id").is_none(),
            "missing media must not invent a media id"
        );
        match attr(&doc, 1, "data-media-missing") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "true"),
            other => panic!("expected data-media-missing, got {other:?}"),
        }
        assert_eq!(built.content_text, "before\nafter");
    }

    #[test]
    fn unresolved_video_card_drops_duration_chrome() {
        let html = r#"
<div class="assetGrid">
  <div class="gridItem assetType_video ">
    <video class="asset_video"><source src="../Resources/absent.mov" type="video/mp4"></video>
    <div>0:15</div>
    <div></div>
    <div></div>
  </div>
</div>
<div class="bodyText"><p>after</p></div>
"#;
        let built = build_ok(html, |_, _| None);
        let doc = decode(&built.update);
        let nodes = top_level(&doc);
        let tags: Vec<&str> = nodes.iter().map(|(tag, _)| tag.as_str()).collect();
        assert_eq!(
            tags,
            vec!["video", "paragraph"],
            "missing video must be one placeholder, not duration/empty chrome: {nodes:?}"
        );
        match attr(&doc, 0, "data-media-missing") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "true"),
            other => panic!("expected data-media-missing, got {other:?}"),
        }
        assert!(
            !built.content_text.contains("0:15"),
            "video duration overlay must not become body text: {}",
            built.content_text
        );
        assert_eq!(nodes[1].1, "after");
    }

    #[test]
    fn remote_media_src_is_not_resolved() {
        let mut seen = Vec::new();
        let built = build_ok(
            r#"<p>keep</p><img src="https://example.com/remote.jpg">"#,
            |kind, src| {
                seen.push((kind, src.to_string()));
                Some("should-not-emit".into())
            },
        );
        let doc = decode(&built.update);
        let content = built.content_text;
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(tags, vec!["paragraph"]);
        assert_eq!(content, "keep");
        assert!(seen.is_empty(), "remote src must not be resolved: {seen:?}");
    }

    #[test]
    fn script_and_style_contents_are_not_emitted() {
        let (doc, content) = build(
            "<style>p{color:red}</style><script>alert(1)</script><p>safe</p><script src=\"https://evil.example/x.js\"></script>",
        );
        assert_eq!(top_level(&doc), vec![("paragraph".into(), "safe".into())]);
        assert_eq!(content, "safe");
        assert!(!content.contains("alert"), "{content}");
        assert!(!content.contains("color"), "{content}");
    }

    #[test]
    fn apple_shaped_document_skips_header_and_title() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-07_rich-yjs.html");
        let built = build_ok(fixture, |kind, src| match (kind, src) {
            (AppleMediaKind::Image, "../Resources/shared-photo.jpg") => Some("media-1".into()),
            other => panic!("unexpected resolve {other:?}"),
        });
        let doc = decode(&built.update);
        let content = built.content_text;
        let nodes = top_level(&doc);
        assert_eq!(nodes[0].0, "image");
        match attr(&doc, 0, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "media-1"),
            other => panic!("expected data-media-id, got {other:?}"),
        }
        assert!(
            nodes
                .iter()
                .any(|(tag, text)| tag == "paragraph" && text.contains("alpha")),
            "body text must be present: {nodes:?}"
        );
        assert!(
            !content.contains("ShouldNotBecomeBody"),
            "page header must not enter the body: {content}"
        );
        assert!(
            !content.contains("Fixture Title"),
            "title must not enter the body: {content}"
        );
        assert!(content.contains("alpha"), "{content}");
        assert!(content.contains("bold"), "{content}");
    }

    fn paragraph_index_containing(doc: &Doc, needle: &str) -> u32 {
        top_level(doc)
            .iter()
            .position(|(tag, text)| tag == "paragraph" && text.contains(needle))
            .unwrap_or_else(|| {
                panic!(
                    "missing paragraph containing {needle:?}: {:?}",
                    top_level(doc)
                )
            }) as u32
    }

    fn marks_for_run(doc: &Doc, index: u32, text: &str) -> Vec<String> {
        paragraph_deltas(doc, index)
            .into_iter()
            .find(|(insert, _)| insert.contains(text))
            .map(|(_, marks)| marks)
            .unwrap_or_else(|| panic!("missing run {text:?} in {:?}", paragraph_deltas(doc, index)))
    }

    fn all_mark_names(doc: &Doc, index: u32) -> Vec<String> {
        let mut names: Vec<String> = paragraph_deltas(doc, index)
            .into_iter()
            .flat_map(|(_, marks)| marks)
            .collect();
        names.sort();
        names.dedup();
        names
    }

    #[test]
    fn inherited_bold_via_class() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-08_css-allowlist.html");
        let (doc, content) = build(fixture);
        let index = paragraph_index_containing(&doc, "inherited");
        assert!(
            marks_for_run(&doc, index, "Outer").contains(&String::from("bold")),
            "outer class must be bold: {:?}",
            paragraph_deltas(&doc, index)
        );
        assert!(
            marks_for_run(&doc, index, "inherited").contains(&String::from("bold")),
            "child without font-weight inherits bold: {:?}",
            paragraph_deltas(&doc, index)
        );
        assert!(content.contains("inherited"), "{content}");
    }

    #[test]
    fn overridden_mark_clears_inherited_bold() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-08_css-allowlist.html");
        let (doc, _) = build(fixture);
        let index = paragraph_index_containing(&doc, "overridden");
        assert!(
            marks_for_run(&doc, index, "kept").contains(&String::from("bold")),
            "parent class stays bold: {:?}",
            paragraph_deltas(&doc, index)
        );
        assert!(
            !marks_for_run(&doc, index, "overridden").contains(&String::from("bold")),
            "font-weight:normal must clear inherited bold: {:?}",
            paragraph_deltas(&doc, index)
        );
        assert!(
            marks_for_run(&doc, index, "after").contains(&String::from("bold")),
            "text after override stays bold: {:?}",
            paragraph_deltas(&doc, index)
        );
    }

    #[test]
    fn non_default_font_color_is_preserved_only_without_color_mark() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-08_css-allowlist.html");
        let built = build_ok(fixture, |_, _| None);
        let doc = decode(&built.update);
        let index = paragraph_index_containing(&doc, "painted");
        let marks = all_mark_names(&doc, index);
        assert!(
            !marks
                .iter()
                .any(|m| m.contains("color") || m == "textStyle"),
            "must not emit a colour mark: {marks:?}"
        );
        let color_warnings: Vec<_> = built
            .warnings
            .iter()
            .filter(|w| w.feature == "font-color")
            .collect();
        assert_eq!(color_warnings.len(), 1, "{:?}", built.warnings);
        assert_eq!(color_warnings[0].kind, AppleConversionKind::PreservedOnly);
        assert_eq!(color_warnings[0].source_value.as_deref(), Some("#c41e3a"));
        assert!(
            built
                .warnings
                .iter()
                .filter(|w| w.feature == "font-color")
                .all(|w| w.source_value.as_deref() != Some("#000000")),
            "document-default black must not warn: {:?}",
            built.warnings
        );
    }

    #[test]
    fn inline_mixed_media_keeps_position() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-09_inline-mixed.html");
        let built = build_ok(fixture, |kind, src| match (kind, src) {
            (AppleMediaKind::Image, "../Resources/shared-photo.jpg") => Some("photo".into()),
            (AppleMediaKind::Video, "../Resources/clip.mov") => Some("video".into()),
            (AppleMediaKind::Audio, "../Resources/memo.m4a") => Some("audio".into()),
            (AppleMediaKind::Image, "../Resources/map-snap.jpg") => Some("map".into()),
            (AppleMediaKind::Image, "../Resources/drawing.png") => Some("drawing".into()),
            (AppleMediaKind::Image, "../Resources/card-extra.jpg") => Some("extra".into()),
            other => panic!("unexpected resolve {other:?}"),
        });
        let doc = decode(&built.update);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        let expected_media = ["image", "video", "audio", "image", "image", "image"];
        let media_tags: Vec<&str> = tags
            .iter()
            .map(String::as_str)
            .filter(|tag| matches!(*tag, "image" | "video" | "audio"))
            .collect();
        assert_eq!(media_tags, expected_media, "tags={tags:?}");

        let text_around = top_level(&doc);
        let seq: Vec<&str> = text_around
            .iter()
            .map(|(tag, text)| {
                if tag == "paragraph" {
                    text.as_str()
                } else {
                    tag.as_str()
                }
            })
            .collect();
        let photo_at = seq.iter().position(|s| *s == "image").expect("photo");
        assert!(
            seq.get(photo_at.wrapping_sub(1)) == Some(&"before photo")
                && seq.get(photo_at + 1) == Some(&"after photo"),
            "photo position: {seq:?}"
        );
        assert!(
            built.content_text.contains("before photo")
                && built.content_text.contains("after drawing"),
            "{}",
            built.content_text
        );
    }

    #[test]
    fn reordered_grid_media_keeps_html_order() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-10_reordered-grid.html");
        let built = build_ok(fixture, |kind, src| match (kind, src) {
            (AppleMediaKind::Video, "../Resources/clip.mov") => Some("video".into()),
            (AppleMediaKind::Image, "../Resources/shared-photo.jpg") => Some("photo".into()),
            (AppleMediaKind::Audio, "../Resources/memo.m4a") => Some("audio".into()),
            other => panic!("unexpected resolve {other:?}"),
        });
        let doc = decode(&built.update);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(
            tags,
            vec![
                String::from("video"),
                String::from("image"),
                String::from("audio"),
                String::from("paragraph")
            ],
            "{tags:?}"
        );
        match attr(&doc, 0, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "video"),
            other => panic!("expected video id, got {other:?}"),
        }
        match attr(&doc, 1, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "photo"),
            other => panic!("expected photo id, got {other:?}"),
        }
    }

    #[test]
    fn transcript_text_is_kept() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-09_inline-mixed.html");
        let built = build_ok(fixture, |kind, src| match src {
            "../Resources/shared-photo.jpg"
            | "../Resources/map-snap.jpg"
            | "../Resources/drawing.png"
            | "../Resources/card-extra.jpg" => Some(format!("{kind:?}")),
            "../Resources/clip.mov" | "../Resources/memo.m4a" => Some(format!("{kind:?}")),
            other => panic!("unexpected src {other}"),
        });
        assert!(
            built.content_text.contains("synthetic transcript line"),
            "transcript must stay in content: {}",
            built.content_text
        );
    }

    #[test]
    fn unknown_card_text_kept_with_warning() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-09_inline-mixed.html");
        let built = build_ok(fixture, |kind, src| match (kind, src) {
            (AppleMediaKind::Image, "../Resources/card-extra.jpg") => Some("extra".into()),
            (_, "../Resources/shared-photo.jpg") => Some("photo".into()),
            (_, "../Resources/clip.mov") => Some("video".into()),
            (_, "../Resources/memo.m4a") => Some("audio".into()),
            (_, "../Resources/map-snap.jpg") => Some("map".into()),
            (_, "../Resources/drawing.png") => Some("drawing".into()),
            other => panic!("unexpected resolve {other:?}"),
        });
        let doc = decode(&built.update);
        assert!(
            built.content_text.contains("unknown card caption"),
            "unknown card visible text must be kept: {}",
            built.content_text
        );
        let warning = built
            .warnings
            .iter()
            .find(|w| w.feature == "unknown-card:reflection")
            .unwrap_or_else(|| panic!("missing unknown-card warning: {:?}", built.warnings));
        assert_eq!(warning.kind, AppleConversionKind::Limitation);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        let extra_at = tags
            .iter()
            .enumerate()
            .find_map(|(i, tag)| {
                if tag == "image" {
                    match attr(&doc, i as u32, "data-media-id") {
                        Some(Out::Any(Any::String(s))) if s.as_ref() == "extra" => Some(i),
                        _ => None,
                    }
                } else {
                    None
                }
            })
            .expect("unknown card resource");
        let nodes = top_level(&doc);
        assert!(
            nodes
                .iter()
                .any(|(tag, text)| { tag == "paragraph" && text.contains("unknown card caption") }),
            "{nodes:?}"
        );
        assert!(
            nodes
                .get(extra_at + 1)
                .is_some_and(|(tag, text)| tag == "paragraph" && text.contains("after unknown")),
            "unknown card resource must keep document position: {nodes:?}"
        );
    }

    #[test]
    fn malformed_cocoa_yjs_keeps_recovered_paragraph_order() {
        let fixture =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-06_malformed-cocoa.html");
        let built = build_ok(fixture, |_, _| None);
        let doc = decode(&built.update);
        let collapsed = top_level(&doc)
            .into_iter()
            .filter(|(tag, _)| tag == "paragraph")
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join(" ");
        let content = format!("{} {collapsed}", built.content_text);
        let alpha = content.find("Alpha").expect("Alpha in Yjs");
        let bravo = content.find("Bravo").expect("Bravo in Yjs");
        let charlie = content.find("Charlie").expect("Charlie in Yjs");
        assert!(
            alpha < bravo && bravo < charlie,
            "Yjs must keep recovered Cocoa body order Alpha/Bravo/Charlie: content={:?} nodes={:?}",
            built.content_text,
            top_level(&doc)
        );
    }

    #[test]
    fn limited_asset_types_warn_and_keep_visible_content() {
        let html = r#"<!DOCTYPE html>
<html><body>
<div class="bodyText">
<p>before drawing</p>
<div class="gridItem assetType_drawing "><img src="drawing.png"><span>drawing caption</span></div>
<p>after drawing</p>
<div class="gridItem assetType_location "><span>location caption</span></div>
<p>after location</p>
<div class="gridItem assetType_livephoto "><img src="live.jpg"><span>live caption</span></div>
<p>after live</p>
</div>
</body></html>"#;
        let built = build_ok(html, |kind, src| match (kind, src) {
            (AppleMediaKind::Image, "drawing.png") => Some("drawing".into()),
            (AppleMediaKind::Image, "live.jpg") => Some("live".into()),
            other => panic!("unexpected resolve {other:?}"),
        });
        let doc = decode(&built.update);
        for feature in [
            "asset-type:drawing",
            "asset-type:location",
            "asset-type:livephoto",
        ] {
            let warning = built
                .warnings
                .iter()
                .find(|w| w.feature == feature)
                .unwrap_or_else(|| panic!("missing {feature}: {:?}", built.warnings));
            assert!(
                matches!(
                    warning.kind,
                    AppleConversionKind::Limitation | AppleConversionKind::PreservedOnly
                ),
                "{feature} must be a limitation/preserved-only warning: {warning:?}"
            );
        }
        assert!(
            built.content_text.contains("drawing caption")
                && built.content_text.contains("location caption")
                && built.content_text.contains("live caption"),
            "limited cards must keep visible text: {}",
            built.content_text
        );
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        let media: Vec<&str> = tags
            .iter()
            .map(String::as_str)
            .filter(|tag| *tag == "image")
            .collect();
        assert_eq!(media, ["image", "image"], "media position kept: {tags:?}");
    }

    #[test]
    fn walker_rejects_unsafe_media_src() {
        let cases = [
            "//evil.example/x.jpg",
            "custom:payload",
            "/etc/passwd",
            "file%3A///tmp/secret.jpg",
        ];
        for src in cases {
            let html = format!(r#"<p>before</p><img src="{src}"><p>after</p>"#);
            let built = build_ok(&html, |_, resolved| -> AppleMediaResolve {
                panic!("must not resolve unsafe src {resolved}")
            });
            let doc = decode(&built.update);
            let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
            assert!(
                !tags.iter().any(|tag| tag == "image"),
                "unsafe src {src} must not become an image node: {tags:?}"
            );
        }
    }

    #[test]
    fn public_builders_enforce_max_yjs_doc_bytes() {
        let over = "x".repeat(MAX_YJS_DOC_BYTES + 1);
        let html = format!("<p>{over}</p>");
        match build_apple_entry_yjs(&html, |_, _| None) {
            Err(AppleYjsError::DocumentTooLarge { max_bytes, bytes }) => {
                assert_eq!(max_bytes, MAX_YJS_DOC_BYTES);
                assert!(bytes > MAX_YJS_DOC_BYTES, "reported {bytes}");
            }
            other => panic!("public builder must reject oversize HTML: {other:?}"),
        }
        match build_apple_entry_yjs_with_map_visits(&html, |_, _| None, &HashMap::new()) {
            Err(AppleYjsError::DocumentTooLarge { max_bytes, .. }) => {
                assert_eq!(max_bytes, MAX_YJS_DOC_BYTES);
            }
            other => panic!("map-visits builder must reject oversize HTML: {other:?}"),
        }
    }

    #[test]
    fn provenance_rejects_raw_html_already_over_max_before_encode() {
        let mut provenance = sample_provenance();
        provenance.raw_html = "r".repeat(MAX_YJS_DOC_BYTES + 1);
        let err = build_apple_entry_yjs_with_provenance("<p>alpha</p>", |_, _| None, &provenance)
            .expect_err("rawHtml over the cap must fail before encode");
        match err {
            AppleYjsError::DocumentTooLarge { max_bytes, bytes } => {
                assert_eq!(max_bytes, MAX_YJS_DOC_BYTES);
                assert_eq!(bytes, MAX_YJS_DOC_BYTES + 1);
            }
        }
    }

    fn sample_provenance() -> AppleJournalProvenance {
        AppleJournalProvenance {
            raw_html: String::from("<p>alpha</p>"),
            sidecars: vec![AppleJournalSidecarRecord {
                relative_name: String::from("Resources/shared-photo.json"),
                json: String::from(r#"{"date":1,"extraKey":true}"#),
            }],
            original_relative_names: vec![
                String::from("Entries/2024-03-01.html"),
                String::from("Resources/shared-photo.jpg"),
            ],
            unknown_fields: vec![AppleJournalUnknownFieldRecord {
                relative_name: String::from("Resources/shared-photo.json"),
                key: String::from("extraKey"),
            }],
            source_dates: vec![
                AppleJournalSourceDateRecord {
                    kind: String::from("filename"),
                    relative_name: String::from("Entries/2024-03-01.html"),
                    value: String::from("2024-03-01"),
                },
                AppleJournalSourceDateRecord {
                    kind: String::from("sidecar"),
                    relative_name: String::from("Resources/shared-photo.json"),
                    value: String::from("1"),
                },
            ],
            resources: vec![AppleJournalResourceRecord {
                relative_name: String::from("Resources/shared-photo.jpg"),
                sha256: String::from("abc123"),
                media_id: Some(String::from("media-1")),
            }],
            visits: Vec::new(),
            native_location: None,
        }
    }

    fn map_visits_from_sidecar(json: &str, media_src: &str) -> HashMap<String, Vec<AppleMapVisit>> {
        let meta = parse_apple_resource_metadata(json, None).expect("map sidecar");
        let mut index = HashMap::new();
        index.insert(media_src.to_string(), meta.visits);
        index
    }

    #[test]
    fn native_location_is_not_duplicated_in_the_body() {
        let html = r#"<!DOCTYPE html>
<html><head><style>
span.sLoc { background-color: #c4a574; }
</style></head><body>
<div class="bodyText">
<p><span class="sLoc">Terminal 2E</span></p>
<p><span class="sLoc"> </span></p>
<div class="gridItem assetType_location "><span class="sLoc">Terminal 2E</span></div>
<div class="gridItem assetType_map"><img class="asset_image" src="../Resources/map-snap.jpg" /></div>
<p>Flight notes after the pin.</p>
</div>
</body></html>"#;
        let json = r#"{
            "visits": [{
                "placeName": "Terminal 2E",
                "latitude": 49.01,
                "longitude": 2.56,
                "city": "Le Mesnil-Amelot"
            }]
        }"#;
        let visits = map_visits_from_sidecar(json, "../Resources/map-snap.jpg");
        let built = build_apple_entry_yjs_with_map_visits(
            html,
            |kind, src| match (kind, src) {
                (AppleMediaKind::Image, "../Resources/map-snap.jpg") => AppleMediaResolve::Attached,
                other => panic!("unexpected resolve {other:?}"),
            },
            &visits,
        )
        .expect("yjs under cap");
        let doc = decode(&built.update);
        let nodes = top_level(&doc);
        let seq: Vec<&str> = nodes
            .iter()
            .map(|(tag, text)| {
                if tag == "paragraph" {
                    text.as_str()
                } else {
                    tag.as_str()
                }
            })
            .collect();
        assert_eq!(
            seq,
            vec!["Flight notes after the pin."],
            "converted location and highlight chrome must not stay in the body: {seq:?}"
        );
        assert!(
            !built.content_text.contains("Terminal 2E"),
            "place name belongs on the location row: {}",
            built.content_text
        );
        let marked = paragraph_deltas(&doc, 0);
        assert!(
            marked
                .iter()
                .all(|(_, marks)| !marks.iter().any(|m| m == "highlight")),
            "leading highlight leftover must be gone: {marked:?}"
        );
    }

    #[test]
    fn map_snapshot_stays_and_visits_are_ordered_readable_text() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-11_map-visits.html");
        let json = include_str!("../tests/fixtures/apple-journal/Resources/map-multi.json");
        let visits = map_visits_from_sidecar(json, "../Resources/map-snap.jpg");
        let built = build_apple_entry_yjs_with_map_visits(
            html,
            |kind, src| match (kind, src) {
                (AppleMediaKind::Image, "../Resources/map-snap.jpg") => Some("map-snap".into()),
                other => panic!("unexpected resolve {other:?}"),
            },
            &visits,
        )
        .expect("yjs under cap");
        let doc = decode(&built.update);
        let nodes = top_level(&doc);
        let seq: Vec<&str> = nodes
            .iter()
            .map(|(tag, text)| {
                if tag == "paragraph" {
                    text.as_str()
                } else {
                    tag.as_str()
                }
            })
            .collect();
        assert!(
            seq.contains(&"image"),
            "map snapshot media must be kept: {seq:?}"
        );
        let image_at = seq.iter().position(|s| *s == "image").expect("snapshot");
        match attr(&doc, image_at as u32, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "map-snap"),
            other => panic!("expected map snapshot id, got {other:?}"),
        }
        assert_eq!(
            seq,
            vec![
                "before map",
                "image",
                "Invalid Peak",
                "Example Harbor, Harbor Town",
                "after map",
            ],
            "native location stays on the location row; extra visits stay readable: {seq:?}"
        );
        assert!(
            !built.content_text.contains("Synthetic Park, Example City"),
            "first valid visit is the native location, not body text: {}",
            built.content_text
        );
        assert!(
            built.content_text.contains("Example Harbor, Harbor Town"),
            "extra visits remain readable: {}",
            built.content_text
        );
    }

    #[test]
    fn zero_visits_still_keeps_map_snapshot() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-11_map-visits.html");
        let json = include_str!("../tests/fixtures/apple-journal/Resources/map-empty.json");
        let visits = map_visits_from_sidecar(json, "../Resources/map-snap.jpg");
        let built = build_apple_entry_yjs_with_map_visits(
            html,
            |kind, src| match (kind, src) {
                (AppleMediaKind::Image, "../Resources/map-snap.jpg") => Some("map-snap".into()),
                other => panic!("unexpected resolve {other:?}"),
            },
            &visits,
        )
        .expect("yjs under cap");
        let doc = decode(&built.update);
        let nodes = top_level(&doc);
        let seq: Vec<&str> = nodes
            .iter()
            .map(|(tag, text)| {
                if tag == "paragraph" {
                    text.as_str()
                } else {
                    tag.as_str()
                }
            })
            .collect();
        assert_eq!(
            seq,
            vec!["before map", "image", "after map"],
            "empty visits must not drop the snapshot or invent text: {seq:?}"
        );
    }

    fn provenance_json(update: &[u8]) -> Any {
        let doc = decode(update);
        let map = doc.get_or_insert_map(APPLE_JOURNAL_IMPORT_ROOT);
        let txn = doc.transact();
        use yrs::types::ToJson;
        map.to_json(&txn)
    }

    fn any_map(value: &Any) -> &std::collections::HashMap<String, Any> {
        match value {
            Any::Map(map) => map,
            other => panic!("expected map, got {other:?}"),
        }
    }

    fn any_array(value: &Any) -> &[Any] {
        match value {
            Any::Array(items) => items,
            other => panic!("expected array, got {other:?}"),
        }
    }

    fn any_str(value: &Any) -> &str {
        match value {
            Any::String(s) => s,
            other => panic!("expected string, got {other:?}"),
        }
    }

    #[test]
    fn provenance_root_map_round_trips_through_encode_decode() {
        let provenance = sample_provenance();
        let built = build_apple_entry_yjs_with_provenance("<p>alpha</p>", |_, _| None, &provenance)
            .expect("small provenance must encode");
        let doc = decode(&built.update);
        assert_eq!(
            top_level(&doc),
            vec![("paragraph".into(), "alpha".into())],
            "fragment default must stay beside the provenance map"
        );

        let root = provenance_json(&built.update);
        let map = any_map(&root);
        assert_eq!(
            any_str(map.get("rawHtml").expect("rawHtml")),
            "<p>alpha</p>"
        );

        let sidecars = any_array(map.get("sidecars").expect("sidecars"));
        assert_eq!(sidecars.len(), 1);
        let sidecar = any_map(&sidecars[0]);
        assert_eq!(
            any_str(sidecar.get("relativeName").expect("sidecar name")),
            "Resources/shared-photo.json"
        );
        assert_eq!(
            any_str(sidecar.get("json").expect("sidecar json")),
            r#"{"date":1,"extraKey":true}"#
        );

        let names = any_array(map.get("originalRelativeNames").expect("names"));
        assert_eq!(
            names.iter().map(any_str).collect::<Vec<_>>(),
            vec!["Entries/2024-03-01.html", "Resources/shared-photo.jpg"]
        );

        let unknown = any_array(map.get("unknownFields").expect("unknownFields"));
        let field = any_map(&unknown[0]);
        assert_eq!(any_str(field.get("key").expect("unknown key")), "extraKey");

        let dates = any_array(map.get("sourceDates").expect("sourceDates"));
        assert_eq!(dates.len(), 2);
        assert_eq!(
            any_str(any_map(&dates[0]).get("value").expect("date value")),
            "2024-03-01"
        );
        assert_eq!(
            any_str(any_map(&dates[1]).get("kind").expect("date kind")),
            "sidecar"
        );

        let resources = any_map(map.get("resources").expect("resources"));
        let photo = any_map(
            resources
                .get("Resources/shared-photo.jpg")
                .expect("resource entry"),
        );
        assert_eq!(any_str(photo.get("sha256").expect("sha256")), "abc123");
        assert_eq!(any_str(photo.get("mediaId").expect("mediaId")), "media-1");

        let visits = any_array(map.get("visits").expect("visits"));
        assert!(visits.is_empty(), "sample provenance has no visits");
        match map.get("nativeLocation") {
            Some(Any::Null) => {}
            other => panic!("empty native location must be null, got {other:?}"),
        }
    }

    #[test]
    fn provenance_stores_ordered_visits_and_native_location() {
        let parsed = parse_apple_resource_metadata(
            include_str!("../tests/fixtures/apple-journal/Resources/map-multi.json"),
            None,
        )
        .expect("map sidecar");
        let native = parsed.native_location.clone().expect("first valid visit");
        let provenance = AppleJournalProvenance {
            visits: parsed
                .visits
                .iter()
                .map(|visit| AppleJournalVisitRecord {
                    media_src: String::from("../Resources/map-snap.jpg"),
                    relative_name: String::from("Resources/map-multi.json"),
                    place_name: visit.place_name.clone(),
                    latitude: visit.latitude,
                    longitude: visit.longitude,
                    city: visit.city.clone(),
                    type_of_place: visit.type_of_place.clone(),
                })
                .collect(),
            native_location: Some(native),
            ..sample_provenance()
        };
        let built = build_apple_entry_yjs_with_provenance("<p>alpha</p>", |_, _| None, &provenance)
            .expect("visit provenance must encode");
        let root = provenance_json(&built.update);
        let map = any_map(&root);
        let visits = any_array(map.get("visits").expect("visits"));
        assert_eq!(visits.len(), 3, "all visits stay in the provenance map");
        let first = any_map(&visits[0]);
        assert_eq!(
            any_str(first.get("placeName").expect("place")),
            "Synthetic Park"
        );
        match first.get("latitude") {
            Some(Any::Number(n)) => assert_eq!(*n, 10.5),
            other => panic!("expected latitude 10.5, got {other:?}"),
        }
        let native = any_map(map.get("nativeLocation").expect("nativeLocation"));
        match native.get("latitude") {
            Some(Any::Number(n)) => assert_eq!(*n, 10.5),
            other => panic!("native latitude, got {other:?}"),
        }
        assert_eq!(
            any_str(native.get("label").expect("label")),
            "Synthetic Park"
        );
    }

    #[test]
    fn provenance_version_key_is_present() {
        let built = build_apple_entry_yjs_with_provenance(
            "<p>alpha</p>",
            |_, _| None,
            &sample_provenance(),
        )
        .expect("small provenance must encode");
        let doc = decode(&built.update);
        let map = doc.get_or_insert_map(APPLE_JOURNAL_IMPORT_ROOT);
        let txn = doc.transact();
        match map.get(&txn, "version") {
            Some(Out::Any(Any::Number(n))) => {
                assert_eq!(n, APPLE_JOURNAL_IMPORT_VERSION);
            }
            other => panic!("expected numeric version key, got {other:?}"),
        }
    }

    #[test]
    fn oversized_source_is_rejected_with_typed_error() {
        let provenance = sample_provenance();
        let err = build_apple_entry_yjs_with_limit("<p>alpha</p>", |_, _| None, &provenance, 1)
            .expect_err("a 1-byte cap must reject the encoded document");
        match err {
            AppleYjsError::DocumentTooLarge { bytes, max_bytes } => {
                assert_eq!(max_bytes, 1);
                assert!(
                    bytes > 1,
                    "encoded size should be the real length, not truncated: {bytes}"
                );
            }
        }
    }

    #[test]
    fn document_exactly_at_limit_is_accepted() {
        let provenance = sample_provenance();
        let built =
            build_apple_entry_yjs_with_limit("<p>alpha</p>", |_, _| None, &provenance, usize::MAX)
                .expect("uncapped encode");
        // Test-only size override: accept this encoded document at its exact
        // length instead of allocating a 10 MiB payload. Production still
        // compares against MAX_YJS_DOC_BYTES.
        assert_eq!(
            enforce_apple_yjs_size(&built.update, built.update.len()),
            Ok(()),
            "a document whose encoded size equals the cap must be accepted"
        );
        let rejected = enforce_apple_yjs_size(&built.update, built.update.len() - 1);
        assert_eq!(
            rejected,
            Err(AppleYjsError::DocumentTooLarge {
                bytes: built.update.len(),
                max_bytes: built.update.len() - 1,
            })
        );
        let accepted = build_apple_entry_yjs_with_limit(
            "<p>alpha</p>",
            |_, _| None,
            &provenance,
            built.update.len(),
        );
        assert!(
            accepted.is_ok(),
            "builder must accept an encode that lands exactly on the cap: {accepted:?}"
        );
    }

    #[test]
    fn production_provenance_builder_uses_shared_max_yjs_doc_bytes() {
        assert_eq!(
            crate::commands::entries::MAX_YJS_DOC_BYTES,
            10 * 1024 * 1024
        );
        let built = build_apple_entry_yjs_with_provenance(
            "<p>alpha</p>",
            |_, _| None,
            &sample_provenance(),
        )
        .expect("synthetic provenance stays under the shared 10 MiB cap");
        assert!(
            built.update.len() <= crate::commands::entries::MAX_YJS_DOC_BYTES,
            "production path must compare against MAX_YJS_DOC_BYTES"
        );
    }

    /// Stable HTML for the committed frontend decode fixture. Script content
    /// is opaque provenance only — it must not appear in fragment `default`.
    const FRONTEND_FIXTURE_HTML: &str = concat!(
        "<p>plain <strong>bold</strong> <em>italic</em> <u>under</u> ",
        "<s>strike</s> <mark>hi</mark> ",
        r#"<a href="https://example.com/path">link</a></p>"#,
        "<h2>Second</h2>",
        "<ul><li>parent<ul><li>child</li></ul></li></ul>",
        r#"<img src="photo.jpg">"#,
        "<p>after</p>",
        "<script>alert('xss-token')</script>",
    );

    fn frontend_fixture_provenance() -> AppleJournalProvenance {
        AppleJournalProvenance {
            raw_html: FRONTEND_FIXTURE_HTML.to_string(),
            sidecars: vec![AppleJournalSidecarRecord {
                relative_name: String::from("Resources/photo.json"),
                json: String::from(r#"{"date":1,"extraKey":true}"#),
            }],
            original_relative_names: vec![String::from("photo.jpg")],
            unknown_fields: vec![AppleJournalUnknownFieldRecord {
                relative_name: String::from("Resources/photo.json"),
                key: String::from("extraKey"),
            }],
            source_dates: vec![AppleJournalSourceDateRecord {
                kind: String::from("filename"),
                relative_name: String::from("Entries/rich.html"),
                value: String::from("2024-03-07"),
            }],
            resources: vec![AppleJournalResourceRecord {
                relative_name: String::from("photo.jpg"),
                sha256: String::from("fixture-sha256"),
                media_id: Some(String::from("media-1")),
            }],
            visits: vec![AppleJournalVisitRecord {
                media_src: String::from("photo.jpg"),
                relative_name: String::from("Resources/photo.json"),
                place_name: Some(String::from("Synthetic Park")),
                latitude: Some(10.5),
                longitude: Some(106.7),
                city: Some(String::from("Example City")),
                type_of_place: None,
            }],
            native_location: Some(crate::import_apple_journal::AppleNativeLocation {
                latitude: 10.5,
                longitude: 106.7,
                label: Some(String::from("Synthetic Park")),
                address: Some(String::from("Example City")),
            }),
        }
    }

    fn build_frontend_fixture_entry() -> AppleEntryYjs {
        build_apple_entry_yjs_with_provenance(
            FRONTEND_FIXTURE_HTML,
            |kind, src| match (kind, src) {
                (AppleMediaKind::Image, "photo.jpg") => Some(String::from("media-1")),
                other => panic!("unexpected resolve {other:?}"),
            },
            &frontend_fixture_provenance(),
        )
        .expect("frontend fixture must stay under the Yjs cap")
    }

    fn frontend_fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/apple-journal/expected/rich-entry.update.bin")
    }

    fn append_paragraph(doc: &Doc, text: &str) {
        use yrs::{XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let fragment = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::new("paragraph", []));
        paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
    }

    fn encode_full(doc: &Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&yrs::StateVector::default())
    }

    /// Builds the synthetic rich entry. With `APPLE_JOURNAL_WRITE_FIXTURES=1`
    /// writes the committed frontend `.bin`; otherwise asserts the committed
    /// update decodes to the same fragment, marks and provenance as a fresh
    /// build. Raw bytes can differ across processes because yrs encodes
    /// `HashMap` attributes in hasher order.
    #[test]
    fn write_frontend_fixture() {
        let built = build_frontend_fixture_entry();
        let dest = frontend_fixture_path();
        if std::env::var("APPLE_JOURNAL_WRITE_FIXTURES")
            .ok()
            .as_deref()
            == Some("1")
        {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).expect("create fixture dir");
            }
            std::fs::write(&dest, &built.update).expect("write rich-entry.update.bin");
            return;
        }
        let committed = std::fs::read(&dest).unwrap_or_else(|e| {
            panic!(
                "committed fixture missing at {}: {e}; regenerate with \
                 APPLE_JOURNAL_WRITE_FIXTURES=1 cargo test --manifest-path \
                 src-tauri/Cargo.toml write_frontend_fixture",
                dest.display()
            )
        });
        assert_eq!(
            fixture_view(&committed),
            fixture_view(&built.update),
            "rich-entry.update.bin drifted from the builder; regenerate with \
             APPLE_JOURNAL_WRITE_FIXTURES=1 cargo test --manifest-path \
             src-tauri/Cargo.toml write_frontend_fixture"
        );
    }

    fn fixture_view(update: &[u8]) -> String {
        let doc = decode(update);
        format!(
            "nodes={:?}\nmarks={:?}\nmedia={:?}\nprovenance={}\n",
            top_level(&doc),
            paragraph_deltas(&doc, 0),
            attr(&doc, 3, "data-media-id"),
            canonical_any(&provenance_json(update))
        )
    }

    fn canonical_any(value: &Any) -> String {
        match value {
            Any::Map(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let fields: Vec<String> = keys
                    .into_iter()
                    .map(|key| format!("{key}:{}", canonical_any(&map[key])))
                    .collect();
                format!("{{{}}}", fields.join(","))
            }
            Any::Array(items) => {
                let fields: Vec<String> = items.iter().map(canonical_any).collect();
                format!("[{}]", fields.join(","))
            }
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn frontend_fixture_keeps_marks_order_and_hides_raw_html() {
        let built = build_frontend_fixture_entry();
        let doc = decode(&built.update);
        let tags: Vec<String> = top_level(&doc).into_iter().map(|(tag, _)| tag).collect();
        assert_eq!(
            tags,
            vec![
                String::from("paragraph"),
                String::from("heading"),
                String::from("bulletList"),
                String::from("image"),
                String::from("paragraph"),
            ],
            "{tags:?}"
        );
        assert_eq!(top_level(&doc)[4].1, "after");
        assert_eq!(
            paragraph_deltas(&doc, 0)
                .into_iter()
                .filter(|(_, marks)| !marks.is_empty())
                .collect::<Vec<_>>(),
            vec![
                (String::from("bold"), vec![String::from("bold")]),
                (String::from("italic"), vec![String::from("italic")]),
                (String::from("under"), vec![String::from("underline")]),
                (String::from("strike"), vec![String::from("strike")]),
                (String::from("hi"), vec![String::from("highlight")]),
                (String::from("link"), vec![String::from("link")]),
            ]
        );
        match attr(&doc, 3, "data-media-id") {
            Some(Out::Any(Any::String(s))) => assert_eq!(s.as_ref(), "media-1"),
            other => panic!("expected media-1, got {other:?}"),
        }
        assert!(
            !built.content_text.contains("xss-token"),
            "script must not become search/plain text: {}",
            built.content_text
        );
        assert!(
            !built.content_text.contains("<script"),
            "raw HTML must not leak into content_text: {}",
            built.content_text
        );
        let root = provenance_json(&built.update);
        let map = any_map(&root);
        assert!(
            any_str(map.get("rawHtml").expect("rawHtml")).contains("xss-token"),
            "opaque rawHtml must retain the script for audit"
        );
    }

    #[test]
    fn provenance_survives_fragment_edit_and_full_state_merge() {
        let built = build_frontend_fixture_entry();
        let local = decode(&built.update);
        append_paragraph(&local, "editor-save-token");
        let after_edit = encode_full(&local);
        let edited = decode(&after_edit);
        assert_eq!(
            any_str(
                any_map(&provenance_json(&after_edit))
                    .get("rawHtml")
                    .unwrap()
            ),
            FRONTEND_FIXTURE_HTML,
            "editor-style fragment edit must not drop appleJournalImport"
        );
        assert!(
            top_level(&edited)
                .iter()
                .any(|(tag, text)| tag == "paragraph" && text == "editor-save-token"),
            "edit must land in fragment default: {:?}",
            top_level(&edited)
        );

        let merged =
            crate::sync::entry_sync::merge_yjs_full_state_updates(&built.update, &after_edit)
                .expect("full-state merge");
        let merged_doc = decode(&merged);
        assert_eq!(
            any_str(any_map(&provenance_json(&merged)).get("rawHtml").unwrap()),
            FRONTEND_FIXTURE_HTML
        );
        assert_eq!(
            any_str(
                any_map(
                    any_map(&provenance_json(&merged))
                        .get("resources")
                        .expect("resources")
                )
                .get("photo.jpg")
                .and_then(|value| match value {
                    Any::Map(map) => map.get("mediaId"),
                    _ => None,
                })
                .expect("mediaId")
            ),
            "media-1"
        );
        assert!(
            top_level(&merged_doc)
                .iter()
                .any(|(tag, text)| tag == "paragraph" && text == "editor-save-token"),
            "merged doc must keep the editor paragraph: {:?}",
            top_level(&merged_doc)
        );
        assert!(
            top_level(&merged_doc)
                .iter()
                .any(|(tag, text)| tag == "paragraph" && text.contains("plain")),
            "merged doc must keep imported body text: {:?}",
            top_level(&merged_doc)
        );
    }
}
