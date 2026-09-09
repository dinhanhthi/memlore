//! Apple Journal folder scanner, entry parser, and Cocoa CSS allowlist (Phase 1).
//!
//! Observed export layout (not an official Apple schema):
//! - root `index.html` listing `Entries/*.html` links
//! - `Entries/*.html` with CSS sections `pageHeader`, `assetGrid`, `title`,
//!   `bodyText` (see the export stylesheet). The document `<title>` is empty
//!   in the inspected variant; entry titles come from `.title` only.
//! - `Resources/` media files plus same-stem `.json` sidecars. Images in the
//!   inspected export have sidecars; videos often do not. Other exports may
//!   share one resource across two entries.
//!
//! Parsing uses [`dom_query`] (html5ever 0.38) so Cocoa-flavoured HTML is
//! tree-built like a browser. Observed Cocoa HTML has invalid
//! paragraph/span/div nesting around `bodyText`; tree repair can move
//! paragraphs out of the wrapper. Body text is recovered by comparing the
//! parsed tree against a tokenizer pass over the raw source. Titles are
//! never invented from filenames or `<title>`.
//!
//! HTML and JSON are read under a byte limit. Media is hashed by streaming
//! and is not subject to the HTML/JSON limit. Unreferenced resources and
//! unknown sidecar keys/cards stay in the scan result; filesystem metadata
//! such as `.DS_Store` is excluded by an explicit name list.
//!
//! Local files only: media `src` values are bound to `Resources/` files by
//! NFC/case-folded filename stem after the path is proven contained in the
//! export root. External URLs, absolute paths, `..` escapes, and symlinks
//! that leave the root are per-ref/per-file errors — never fetched, never
//! guessed. Malformed sidecar JSON is a per-file error; the scan continues.
//! CSS and scripts are not executed. An allowlist of Cocoa class / inline CSS
//! (`font-weight`, `font-style`, `text-decoration`, background highlight) is
//! parsed for the Yjs walker; font colour is preserved-only (see `docs/LATER.md`).
//!
//! Entry dates: the visible HTML calendar date wins; the filename date is a
//! fallback only when the header is absent or unreadable. That precedence is
//! importer policy (2026-09-07), not an Apple-documented rule. Dates are
//! stored as date-only; the Unix timestamp is synthetic local noon in the
//! conversion timezone and is never an original entry clock. Invalid or
//! ambiguous local times are rejected instead of guessing an offset.
//! Resource sidecar dates are converted from the Apple reference date
//! (2001-01-01 UTC); that mapping is an evidence-based inference, not a
//! published Journal schema. Image dates never become the entry date.
//! Map visits stay in source order: the first valid coordinate pair is the
//! native location; all visits remain readable text plus structured metadata.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use chrono::{Datelike, NaiveDate, TimeZone};
use dom_query::Document;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// Max bytes read into memory for one HTML document (entry or index).
pub const MAX_APPLE_JOURNAL_HTML_BYTES: u64 = 64 * 1024 * 1024;
/// Max bytes read into memory for one sidecar JSON file.
pub const MAX_APPLE_JOURNAL_JSON_BYTES: u64 = 64 * 1024 * 1024;

/// Byte limits for HTML/JSON reads. Media is streamed and not capped here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppleJournalScanLimits {
    pub max_html_bytes: u64,
    pub max_json_bytes: u64,
}

impl Default for AppleJournalScanLimits {
    fn default() -> Self {
        Self {
            max_html_bytes: MAX_APPLE_JOURNAL_HTML_BYTES,
            max_json_bytes: MAX_APPLE_JOURNAL_JSON_BYTES,
        }
    }
}

/// Folder scan: parsed entries, resource inventory, and index cross-check hrefs.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleJournalFolder {
    /// Absolute export folder used for stage-time containment re-checks.
    pub root: PathBuf,
    pub entries: Vec<AppleJournalEntry>,
    /// `href` values from root `index.html` that point at `Entries/*.html`.
    /// Observed cross-check list — not counted as entries.
    pub index_entry_hrefs: Vec<String>,
    pub resources: Vec<AppleJournalResource>,
    /// Resources present on disk but referenced by no entry. Never dropped.
    pub unreferenced_resources: Vec<AppleJournalResource>,
    /// Sidecar object keys that are not in the observed allowlist.
    pub unknown_sidecar_keys: Vec<AppleJournalUnknownSidecarKey>,
    /// Entry cards whose `assetType_*` class is not a known observed type.
    pub unknown_cards: Vec<AppleJournalUnknownCard>,
    /// Per-file / per-ref problems. The scan continues unless the root is invalid.
    pub errors: Vec<AppleJournalScanError>,
}

/// One rejected path, corrupt sidecar, or ambiguous name. Never a silent bind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalScanError {
    /// Entry or resource path this error is attached to, when known.
    pub relative_path: Option<PathBuf>,
    /// Media `src` that failed, when this is a per-ref error.
    pub src: Option<String>,
    pub kind: AppleJournalErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleJournalErrorKind {
    PathEscape,
    AbsolutePath,
    ExternalUrl,
    SymlinkEscape,
    CorruptSidecar,
    AmbiguousName,
    HtmlOverLimit,
    JsonOverLimit,
    UnreadableResource,
}

/// A sidecar field that is retained for accounting, not silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalUnknownSidecarKey {
    pub relative_path: PathBuf,
    pub key: String,
}

/// An entry card whose observed `assetType_*` class has no importer mapping yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalUnknownCard {
    pub relative_path: PathBuf,
    pub asset_type: String,
}

/// How a non-native Apple Journal feature was handled during conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleConversionKind {
    /// Kept as source metadata; not converted to an editor mark or node.
    PreservedOnly,
    /// Visible content kept; there is no native editor equivalent.
    Limitation,
}

impl AppleConversionKind {
    pub fn as_import_kind(self) -> &'static str {
        match self {
            Self::PreservedOnly => "preserved_only",
            Self::Limitation => "limitation",
        }
    }
}

/// One precise conversion warning for a non-native feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleConversionWarning {
    pub kind: AppleConversionKind,
    pub feature: String,
    pub message: String,
    /// Raw source value retained when the feature is preserved-only.
    pub source_value: Option<String>,
}

/// Allowlisted Cocoa class / inline CSS marks (observed export, not an official schema).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AppleCssMarks {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub highlight: Option<bool>,
}

impl AppleCssMarks {
    /// Local `Some` values override the parent; `None` inherits.
    pub fn merge_inherited(parent: Self, local: Self) -> Self {
        Self {
            bold: local.bold.or(parent.bold),
            italic: local.italic.or(parent.italic),
            underline: local.underline.or(parent.underline),
            strike: local.strike.or(parent.strike),
            highlight: local.highlight.or(parent.highlight),
        }
    }
}

/// One simple Cocoa stylesheet rule (`span.s2`, `.s2`, `p.p1`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleCssRule {
    pub element: Option<String>,
    pub class: Option<String>,
    pub declarations: Vec<(String, String)>,
}

/// One `Entries/*.html` document after HTML5 parse + resource binding.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleJournalEntry {
    pub relative_path: PathBuf,
    /// Text of the first `.title` element, if non-empty. Never filename or `<title>`.
    pub title: Option<String>,
    /// Visible text of `.bodyText` (entities decoded; `<br>` → newline). Empty if absent.
    pub body_text: String,
    /// Source file contents as read, retained for later provenance.
    pub raw_html: String,
    pub media_refs: Vec<AppleJournalMediaRef>,
}

/// A media `src` from the entry HTML, bound to a local file and sidecar when present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalMediaRef {
    pub src: String,
    pub stem: String,
    pub media_path: Option<PathBuf>,
    pub sidecar_path: Option<PathBuf>,
}

/// A binary file in `Resources/` with an optional same-stem JSON sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleJournalResource {
    pub stem: String,
    pub media_path: PathBuf,
    pub sidecar_path: Option<PathBuf>,
    /// File length from the streaming hash pass — the file is never read whole.
    pub byte_len: u64,
    pub sha256: String,
}

/// Parsed entry fields before folder-level resource binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAppleEntry {
    pub title: Option<String>,
    pub body_text: String,
    pub raw_html: String,
    pub media_srcs: Vec<String>,
}

/// Scan an extracted Apple Journal folder. Struct output only — no Yjs, no DB.
pub fn scan_apple_journal_folder(root: impl AsRef<Path>) -> Result<AppleJournalFolder, String> {
    scan_apple_journal_folder_with_limits(root, AppleJournalScanLimits::default())
}

/// Scan with explicit HTML/JSON byte limits. Media is streamed and uncapped.
pub fn scan_apple_journal_folder_with_limits(
    root: impl AsRef<Path>,
    limits: AppleJournalScanLimits,
) -> Result<AppleJournalFolder, String> {
    let root = root.as_ref();
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    let mut errors = Vec::new();
    let mut unknown_sidecar_keys = Vec::new();
    let index_entry_hrefs = read_index_entry_hrefs(
        root,
        &root.join("index.html"),
        limits.max_html_bytes,
        &mut errors,
    )?;
    let resources = inventory_resources(
        root,
        &root.join("Resources"),
        limits.max_json_bytes,
        &mut errors,
        &mut unknown_sidecar_keys,
    )?;
    let lookup = build_resource_lookup(&resources, &mut errors);

    let entries_dir = root.join("Entries");
    if !entries_dir.is_dir() {
        return Err(format!(
            "missing Entries directory: {}",
            entries_dir.display()
        ));
    }

    let mut entry_paths: Vec<PathBuf> = fs::read_dir(&entries_dir)
        .map_err(|e| format!("read Entries: {e}"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| is_entry_html_path(path))
        .collect();
    entry_paths.sort();

    let mut entries = Vec::with_capacity(entry_paths.len());
    let mut unknown_cards = Vec::new();
    for path in entry_paths {
        let relative_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        if entry_html_is_unreadable(root, &path) {
            errors.push(scan_error(
                Some(relative_path),
                None,
                AppleJournalErrorKind::SymlinkEscape,
                format!(
                    "entry HTML leaves the export root or is a symlink: {}",
                    path.display()
                ),
            ));
            continue;
        }
        let raw_html = match read_text_limited(&path, limits.max_html_bytes) {
            Ok(Ok(text)) => text,
            Ok(Err(len)) => {
                errors.push(scan_error(
                    Some(relative_path),
                    None,
                    AppleJournalErrorKind::HtmlOverLimit,
                    format!(
                        "HTML exceeds {} bytes ({len}): {}",
                        limits.max_html_bytes,
                        path.display()
                    ),
                ));
                continue;
            }
            Err(e) => {
                errors.push(scan_error(
                    Some(relative_path),
                    None,
                    AppleJournalErrorKind::UnreadableResource,
                    format!("unreadable entry HTML: {e}"),
                ));
                continue;
            }
        };
        let parsed = parse_apple_entry(&raw_html);
        unknown_cards.extend(collect_unknown_cards(&raw_html, &relative_path));
        let entry_dir = path.parent().unwrap_or(root);
        let mut media_refs = Vec::with_capacity(parsed.media_srcs.len());
        for src in &parsed.media_srcs {
            if let Some(media_ref) =
                bind_media_ref(src, &relative_path, root, entry_dir, &lookup, &mut errors)
            {
                media_refs.push(media_ref);
            }
        }
        entries.push(AppleJournalEntry {
            relative_path,
            title: parsed.title,
            body_text: parsed.body_text,
            raw_html: parsed.raw_html,
            media_refs,
        });
    }

    let referenced: HashSet<PathBuf> = entries
        .iter()
        .flat_map(|entry| entry.media_refs.iter())
        .filter_map(|media| media.media_path.clone())
        .collect();
    let unreferenced_resources: Vec<AppleJournalResource> = resources
        .iter()
        .filter(|resource| !referenced.contains(&resource.media_path))
        .cloned()
        .collect();

    Ok(AppleJournalFolder {
        root: root.to_path_buf(),
        entries,
        index_entry_hrefs,
        resources,
        unreferenced_resources,
        unknown_sidecar_keys,
        unknown_cards,
        errors,
    })
}

/// Parse one entry HTML document. Does not invent a title from a filename.
pub fn parse_apple_entry(html: &str) -> ParsedAppleEntry {
    let document = Document::from(html);

    let title = nonempty_text(&document.select(".title"));
    let body_text = recover_body_text(html, &document);

    let mut media_srcs = Vec::new();
    for node in document
        .select("img[src], source[src], video[src], audio[src]")
        .iter()
    {
        if let Some(src) = node.attr("src") {
            let src = src.to_string();
            if !src.is_empty() {
                media_srcs.push(src);
            }
        }
    }

    ParsedAppleEntry {
        title,
        body_text,
        raw_html: html.to_string(),
        media_srcs,
    }
}

fn nonempty_text(selection: &dom_query::Selection<'_>) -> Option<String> {
    if !selection.exists() {
        return None;
    }
    let trimmed = selection.text().to_string();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Observed Cocoa section class names (not an official Apple schema).
const OBSERVED_SECTION_CLASSES: &[&str] = &["pageHeader", "assetGrid", "title", "bodyText"];

/// Observed `assetType_*` cards that convert to native editor nodes.
const NATIVE_ASSET_TYPES: &[&str] = &["photo", "video", "audio", "map"];

/// Observed cards that are not fully converted: keep visible text/media, warn.
/// TODO(later): Live Photo motion (paired video) is not imported; still image
/// only. See docs/LATER.md.
const LIMITED_ASSET_TYPES: &[&str] = &["location", "drawing", "livephoto", "live_photo"];

/// True when `assetType_*` is a known observed card (photo/video/audio/map/drawing/…).
#[cfg(test)]
pub fn is_known_apple_asset_type(asset_type: &str) -> bool {
    is_fully_mapped_apple_asset_type(asset_type) || is_limited_apple_asset_type(asset_type)
}

/// True when the card maps to a native editor node (image/video/audio/map).
pub fn is_fully_mapped_apple_asset_type(asset_type: &str) -> bool {
    NATIVE_ASSET_TYPES.contains(&asset_type.to_ascii_lowercase().as_str())
}

/// True when the card is observed but only preserved/limited, not fully converted.
pub fn is_limited_apple_asset_type(asset_type: &str) -> bool {
    LIMITED_ASSET_TYPES.contains(&asset_type.to_ascii_lowercase().as_str())
}

/// First `assetType_*` token from a `class` attribute, folded to lowercase.
pub fn apple_asset_type_from_class(class_attr: &str) -> Option<String> {
    class_attr.split_whitespace().find_map(|part| {
        part.strip_prefix("assetType_")
            .filter(|rest| !rest.is_empty())
            .map(|rest| rest.to_ascii_lowercase())
    })
}

/// Parse `<style>` blocks into simple Cocoa class rules. CSS is not executed.
pub fn parse_apple_stylesheet(html: &str) -> Vec<AppleCssRule> {
    let mut rules = Vec::new();
    let mut rest = html;
    while let Some(open) = find_ignore_ascii_case(rest, "<style") {
        let after_open = &rest[open + "<style".len()..];
        let Some(tag_end) = after_open.find('>') else {
            break;
        };
        let css_start = &after_open[tag_end + 1..];
        let Some(close) = find_ignore_ascii_case(css_start, "</style>") else {
            break;
        };
        parse_css_rules(&css_start[..close], &mut rules);
        rest = &css_start[close + "</style>".len()..];
    }
    rules
}

/// Cascade matching stylesheet rules, then the element's inline `style`.
pub fn collect_element_declarations(
    stylesheet: &[AppleCssRule],
    tag: &str,
    classes: &[String],
    inline_style: Option<&str>,
) -> Vec<(String, String)> {
    let mut decls: Vec<(String, String)> = Vec::new();
    for rule in stylesheet {
        if css_rule_matches(rule, tag, classes) {
            for (prop, value) in &rule.declarations {
                upsert_decl(&mut decls, prop, value);
            }
        }
    }
    if let Some(inline) = inline_style {
        for (prop, value) in parse_css_declarations(inline) {
            upsert_decl(&mut decls, &prop, &value);
        }
    }
    decls
}

/// Map allowlisted properties: font-weight, font-style, text-decoration, background highlight.
pub fn resolve_apple_css_marks(declarations: &[(String, String)]) -> AppleCssMarks {
    let mut marks = AppleCssMarks::default();
    if let Some(font) = css_decl(declarations, "font") {
        apply_font_shorthand(&mut marks, font);
    }
    if let Some(weight) = css_decl(declarations, "font-weight") {
        marks.bold = parse_font_weight(weight);
    }
    if let Some(style) = css_decl(declarations, "font-style") {
        marks.italic = parse_font_style(style);
    }
    if let Some(decoration) = css_decl(declarations, "text-decoration")
        .or_else(|| css_decl(declarations, "text-decoration-line"))
    {
        apply_text_decoration(&mut marks, decoration);
    }
    if let Some(background) =
        css_decl(declarations, "background-color").or_else(|| css_decl(declarations, "background"))
    {
        marks.highlight = Some(is_highlight_background(background));
    }
    marks
}

/// Raw `color` when it is not the document-default black. Apple fonts / page grid are ignored.
pub fn extract_non_default_font_color(declarations: &[(String, String)]) -> Option<String> {
    let color = css_decl(declarations, "color")?;
    if is_default_document_color(color) {
        None
    } else {
        Some(color.to_string())
    }
}

/// Document-default black (and equivalents). Intentional Journal colours are anything else.
pub fn is_default_document_color(value: &str) -> bool {
    let t = normalize_css_color(value);
    matches!(
        t.as_str(),
        "black"
            | "#000"
            | "#000000"
            | "rgb(0,0,0)"
            | "rgba(0,0,0,1)"
            | "rgba(0,0,0,1.0)"
            | "rgb(0%,0%,0%)"
            | "windowtext"
    ) || t.starts_with("rgba(0,0,0,1")
}

/// How precisely the source described the entry date. Export HTML is a day only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleDatePrecision {
    DateOnly,
}

/// Which source supplied the chosen calendar date. Precedence is importer policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleDateSource {
    HtmlHeader,
    FilenameFallback,
    None,
}

/// Reviewable date-policy warning. Not an Apple-documented diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleDateWarningKind {
    HeaderFilenameConflict,
    SourcesUnreadable,
    NonexistentLocalTime,
    AmbiguousLocalTime,
}

impl AppleDateWarningKind {
    pub fn as_import_kind(self) -> &'static str {
        match self {
            Self::HeaderFilenameConflict => "header_filename_conflict",
            Self::SourcesUnreadable => "sources_unreadable",
            Self::NonexistentLocalTime => "nonexistent_local_time",
            Self::AmbiguousLocalTime => "ambiguous_local_time",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleDateWarning {
    pub kind: AppleDateWarningKind,
    pub message: String,
}

/// Resolved journal date plus provenance. The stored clock is synthetic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleResolvedEntryDate {
    pub calendar_date: Option<NaiveDate>,
    /// Local noon in `conversion_timezone`, if that civil time exists uniquely.
    pub entry_date_unix: Option<i64>,
    pub precision: AppleDatePrecision,
    pub header_date_raw: Option<String>,
    pub header_date: Option<NaiveDate>,
    pub filename_date_raw: Option<String>,
    pub filename_date: Option<NaiveDate>,
    pub conversion_timezone: String,
    pub chosen_source: AppleDateSource,
    /// Import-time bookkeeping. Original created/updated clocks are unknown.
    pub imported_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Always true so EXIF auto-suggestion cannot override an imported date.
    pub entry_date_user_edited: bool,
    pub warnings: Vec<AppleDateWarning>,
}

/// Resolve the entry calendar date under the confirmed HTML-date policy.
///
/// The visible `.pageHeader` date wins. The filename `YYYY-MM-DD` token is
/// used only when the header is absent or unreadable. Conflicting or
/// unreadable sources produce warnings. The Unix timestamp is local noon in
/// `conversion_tz` and must not be described as an original entry time.
pub fn resolve_apple_entry_date<Tz: TimeZone>(
    html: &str,
    source_name: &str,
    conversion_tz: &Tz,
    conversion_tz_name: &str,
    imported_at: i64,
) -> AppleResolvedEntryDate {
    let header_date_raw = extract_page_header_raw(html);
    let header_date = header_date_raw
        .as_deref()
        .and_then(parse_visible_calendar_date);
    let (filename_date_raw, filename_date) = parse_filename_calendar_date(source_name);

    let mut warnings = Vec::new();
    let (calendar_date, chosen_source) = match (header_date, filename_date) {
        (Some(header), Some(filename)) => {
            if header != filename {
                warnings.push(date_warning(
                    AppleDateWarningKind::HeaderFilenameConflict,
                    format!(
                        "HTML calendar date {header} differs from filename date {filename}; using the HTML date (importer policy)"
                    ),
                ));
            }
            (Some(header), AppleDateSource::HtmlHeader)
        }
        (Some(header), None) => (Some(header), AppleDateSource::HtmlHeader),
        (None, Some(filename)) => (Some(filename), AppleDateSource::FilenameFallback),
        (None, None) => {
            warnings.push(date_warning(
                AppleDateWarningKind::SourcesUnreadable,
                "entry has no readable HTML calendar date or filename date",
            ));
            (None, AppleDateSource::None)
        }
    };

    let entry_date_unix = match calendar_date {
        Some(date) => match project_local_noon(date, conversion_tz) {
            Ok(ts) => Some(ts),
            Err(LocalNoonError::Nonexistent) => {
                warnings.push(date_warning(
                    AppleDateWarningKind::NonexistentLocalTime,
                    format!(
                        "local noon on {date} does not exist in {conversion_tz_name}; not guessing an offset"
                    ),
                ));
                None
            }
            Err(LocalNoonError::Ambiguous) => {
                warnings.push(date_warning(
                    AppleDateWarningKind::AmbiguousLocalTime,
                    format!(
                        "local noon on {date} is ambiguous in {conversion_tz_name}; not guessing an offset"
                    ),
                ));
                None
            }
        },
        None => None,
    };

    AppleResolvedEntryDate {
        calendar_date,
        entry_date_unix,
        precision: AppleDatePrecision::DateOnly,
        header_date_raw,
        header_date,
        filename_date_raw,
        filename_date,
        conversion_timezone: conversion_tz_name.to_string(),
        chosen_source,
        imported_at,
        created_at: imported_at,
        updated_at: imported_at,
        entry_date_user_edited: true,
        warnings,
    }
}

/// Same as [`resolve_apple_entry_date`] using the importing system's local zone.
#[cfg(test)]
pub fn resolve_apple_entry_date_local(
    html: &str,
    source_name: &str,
    imported_at: i64,
) -> AppleResolvedEntryDate {
    resolve_apple_entry_date(
        html,
        source_name,
        &chrono::Local,
        "system-local",
        imported_at,
    )
}

/// Unix seconds for Foundation's reference date (2001-01-01 00:00:00 UTC).
/// Export `date` numbers are interpreted as this epoch by inference, not as
/// a documented Journal JSON schema.
pub const APPLE_REFERENCE_DATE_UNIX_SECONDS: f64 = 978_307_200.0;

/// Optional independent capture clock (for example EXIF DateTimeOriginal).
/// Compared to the sidecar only; never used to invent a timezone offset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AppleEmbeddedCapture {
    pub unix_seconds: f64,
}

/// Reviewable resource-metadata warning. Not an Apple-documented diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleResourceWarningKind {
    CaptureDateDisagreement,
    InvalidCoordinates,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleResourceWarning {
    pub kind: AppleResourceWarningKind,
    pub message: String,
}

/// One observed map `visits[]` object. Coordinates may be absent or invalid.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleMapVisit {
    pub place_name: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub city: Option<String>,
    pub type_of_place: Option<String>,
    pub coordinates_valid: bool,
}

/// Native entry location taken from the first valid visit in source order.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleNativeLocation {
    pub latitude: f64,
    pub longitude: f64,
    pub label: Option<String>,
    pub address: Option<String>,
}

/// Parsed image or map sidecar. Observed fields only — not an official schema.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleParsedResourceMetadata {
    /// Original `date` number text, including any fractional digits.
    pub date_raw: Option<String>,
    /// Sidecar `date` converted to Unix seconds, fraction retained.
    pub date_unix: Option<f64>,
    pub place_name: Option<String>,
    pub visits: Vec<AppleMapVisit>,
    pub native_location: Option<AppleNativeLocation>,
    pub warnings: Vec<AppleResourceWarning>,
}

/// Parse one observed image/map sidecar. Does not geocode and does not
/// change the entry calendar date.
pub fn parse_apple_resource_metadata(
    json: &str,
    embedded_capture: Option<AppleEmbeddedCapture>,
) -> Result<AppleParsedResourceMetadata, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("malformed sidecar JSON: {e}"))?;
    let Some(obj) = value.as_object() else {
        return Ok(AppleParsedResourceMetadata {
            date_raw: None,
            date_unix: None,
            place_name: None,
            visits: Vec::new(),
            native_location: None,
            warnings: Vec::new(),
        });
    };

    let (date_raw, date_unix) = parse_apple_sidecar_date(obj.get("date"));
    let place_name = json_nonempty_str(obj.get("placeName"));

    let mut warnings = Vec::new();
    let mut visits = Vec::new();
    if let Some(array) = obj.get("visits").and_then(|v| v.as_array()) {
        for visit in array {
            visits.push(parse_apple_map_visit(visit, &mut warnings));
        }
    }

    if let (Some(sidecar_unix), Some(embedded)) = (date_unix, embedded_capture) {
        if (sidecar_unix - embedded.unix_seconds).abs() > 1.0 {
            warnings.push(AppleResourceWarning {
                kind: AppleResourceWarningKind::CaptureDateDisagreement,
                message: String::from(
                    "embedded capture time disagrees with the sidecar date; keeping the sidecar conversion and not guessing a timezone offset",
                ),
            });
        }
    }

    let native_location = first_valid_apple_native_location(&visits);

    Ok(AppleParsedResourceMetadata {
        date_raw,
        date_unix,
        place_name,
        visits,
        native_location,
        warnings,
    })
}

/// First visit with a valid WGS84 pair becomes the native map pin.
pub fn first_valid_apple_native_location(visits: &[AppleMapVisit]) -> Option<AppleNativeLocation> {
    visits.iter().find_map(|visit| {
        if !visit.coordinates_valid {
            return None;
        }
        Some(AppleNativeLocation {
            latitude: visit.latitude?,
            longitude: visit.longitude?,
            label: visit.place_name.clone(),
            address: visit.city.clone(),
        })
    })
}

/// Place name and city as readable entry text. Coordinates stay in metadata.
pub fn apple_visit_readable_line(visit: &AppleMapVisit) -> Option<String> {
    match (&visit.place_name, &visit.city) {
        (Some(place), Some(city)) => Some(format!("{place}, {city}")),
        (Some(place), None) => Some(place.clone()),
        (None, Some(city)) => Some(city.clone()),
        (None, None) => visit.type_of_place.clone(),
    }
}

fn parse_apple_sidecar_date(value: Option<&serde_json::Value>) -> (Option<String>, Option<f64>) {
    let Some(value) = value else {
        return (None, None);
    };
    let Some(number) = value.as_number() else {
        return (None, None);
    };
    let raw = number.to_string();
    let Some(apple_seconds) = number.as_f64().filter(|n| n.is_finite()) else {
        return (Some(raw), None);
    };
    (
        Some(raw),
        Some(apple_seconds + APPLE_REFERENCE_DATE_UNIX_SECONDS),
    )
}

fn parse_apple_map_visit(
    value: &serde_json::Value,
    warnings: &mut Vec<AppleResourceWarning>,
) -> AppleMapVisit {
    let obj = value.as_object();
    let place_name = obj.and_then(|o| json_nonempty_str(o.get("placeName")));
    let city = obj.and_then(|o| json_nonempty_str(o.get("city")));
    let type_of_place = obj.and_then(|o| json_nonempty_str(o.get("typeOfPlace")));
    let latitude = obj.and_then(|o| json_finite_f64(o.get("latitude")));
    let longitude = obj.and_then(|o| json_finite_f64(o.get("longitude")));

    let present_pair = latitude.is_some() && longitude.is_some();
    let coordinates_valid = match (latitude, longitude) {
        (Some(lat), Some(lon)) => is_valid_wgs84(lat, lon),
        _ => false,
    };
    if present_pair && !coordinates_valid {
        warnings.push(AppleResourceWarning {
            kind: AppleResourceWarningKind::InvalidCoordinates,
            message: String::from(
                "map visit coordinates are outside WGS84 bounds; visit is kept but not used as the native location",
            ),
        });
    }

    AppleMapVisit {
        place_name,
        latitude,
        longitude,
        city,
        type_of_place,
        coordinates_valid,
    }
}

fn json_nonempty_str(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn json_finite_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|v| v.as_f64()).filter(|n| n.is_finite())
}

fn is_valid_wgs84(latitude: f64, longitude: f64) -> bool {
    (-90.0..=90.0).contains(&latitude) && (-180.0..=180.0).contains(&longitude)
}

fn date_warning(kind: AppleDateWarningKind, message: impl Into<String>) -> AppleDateWarning {
    AppleDateWarning {
        kind,
        message: message.into(),
    }
}

fn extract_page_header_raw(html: &str) -> Option<String> {
    // Cocoa HTML often has invalid nesting. HTML5 tree repair can pull
    // following sections into `.pageHeader`, which then fails the English
    // calendar parse and silently falls back to the filename date.
    // Only return a slice that parses as a calendar date.
    let tokenized = tokenize_section_text(html, "pageHeader");
    if let Some(raw) = first_parseable_calendar_header(&tokenized) {
        return Some(raw);
    }
    let document = Document::from(html);
    nonempty_text(&document.select(".pageHeader"))
        .and_then(|text| first_parseable_calendar_header(&text))
}

/// First parseable calendar date in a header slice. Extra leftover tokens
/// after an unclosed `.pageHeader` must not force a filename fallback.
fn first_parseable_calendar_header(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if parse_visible_calendar_date(raw).is_some() {
        return Some(raw.to_string());
    }
    if let Some(line) = raw.lines().next() {
        let line = line.trim();
        if !line.is_empty() && line != raw && parse_visible_calendar_date(line).is_some() {
            return Some(line.to_string());
        }
    }
    let (head, rest) = raw.split_once(',')?;
    if parse_english_weekday(head.trim()).is_none() {
        return None;
    }
    let (month_day, year_and_rest) = rest.split_once(',')?;
    let year_tok = year_and_rest.split_whitespace().next()?;
    let candidate = format!("{}, {}, {}", head.trim(), month_day.trim(), year_tok);
    parse_visible_calendar_date(&candidate).map(|_| candidate)
}

/// Parse the observed English header (`Monday, March 1, 2024`) or `YYYY-MM-DD`.
fn parse_visible_calendar_date(raw: &str) -> Option<NaiveDate> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Some(date);
    }
    let body = match raw.split_once(',') {
        Some((head, rest)) if parse_english_weekday(head.trim()).is_some() => rest.trim(),
        _ => raw,
    };
    let (month_day, year_part) = body.split_once(',')?;
    let year: i32 = year_part.trim().parse().ok()?;
    let mut parts = month_day.split_whitespace();
    let month = parse_english_month(parts.next()?)?;
    let day: u32 = parts.next()?.trim_end_matches(',').parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)
}

fn parse_english_weekday(value: &str) -> Option<()> {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
    )
    .then_some(())
}

fn parse_english_month(value: &str) -> Option<u32> {
    match value.to_ascii_lowercase().as_str() {
        "january" => Some(1),
        "february" => Some(2),
        "march" => Some(3),
        "april" => Some(4),
        "may" => Some(5),
        "june" => Some(6),
        "july" => Some(7),
        "august" => Some(8),
        "september" => Some(9),
        "october" => Some(10),
        "november" => Some(11),
        "december" => Some(12),
        _ => None,
    }
}

/// Leading `YYYY-MM-DD` on the file stem. Invalid civil dates keep the raw token.
fn parse_filename_calendar_date(source_name: &str) -> (Option<String>, Option<NaiveDate>) {
    let name = Path::new(source_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(source_name);
    let Some(prefix) = name.get(..10).filter(|prefix| prefix.is_ascii()) else {
        return (None, None);
    };
    let bytes = prefix.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return (None, None);
    }
    if !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return (None, None);
    }
    let rest = &name[10..];
    if !rest.is_empty() && !rest.starts_with('_') && !rest.starts_with('.') {
        return (None, None);
    }
    let token = name[..10].to_string();
    let parsed = NaiveDate::parse_from_str(&token, "%Y-%m-%d").ok();
    (Some(token), parsed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalNoonError {
    Nonexistent,
    Ambiguous,
}

fn project_local_noon<Tz: TimeZone>(date: NaiveDate, tz: &Tz) -> Result<i64, LocalNoonError> {
    match tz.with_ymd_and_hms(date.year(), date.month(), date.day(), 12, 0, 0) {
        chrono::MappedLocalTime::Single(dt) => Ok(dt.timestamp()),
        chrono::MappedLocalTime::None => Err(LocalNoonError::Nonexistent),
        chrono::MappedLocalTime::Ambiguous(_, _) => Err(LocalNoonError::Ambiguous),
    }
}

fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| {
            window
                .iter()
                .zip(needle.iter())
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
        })
}

fn parse_css_rules(css: &str, rules: &mut Vec<AppleCssRule>) {
    let stripped = strip_css_comments(css);
    let mut rest = stripped.as_str();
    while let Some(open) = rest.find('{') {
        let selector_list = rest[..open].trim();
        let after = &rest[open + 1..];
        let Some(close) = find_declaration_block_end(after) else {
            break;
        };
        let decls = parse_css_declarations(&after[..close]);
        for selector in selector_list.split(',') {
            if let Some((element, class)) = parse_simple_selector(selector) {
                rules.push(AppleCssRule {
                    element,
                    class,
                    declarations: decls.clone(),
                });
            }
        }
        rest = after.get(close + 1..).unwrap_or("");
    }
}

fn strip_css_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn find_declaration_block_end(css: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_quote: Option<char> = None;
    for (idx, ch) in css.char_indices() {
        match (in_quote, ch) {
            (Some(q), c) if c == q => in_quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => in_quote = Some(ch),
            (None, '{') => depth += 1,
            (None, '}') if depth == 0 => return Some(idx),
            (None, '}') => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    None
}

fn parse_simple_selector(selector: &str) -> Option<(Option<String>, Option<String>)> {
    let selector = selector.trim();
    if selector.is_empty()
        || selector.contains(char::is_whitespace)
        || selector.contains('>')
        || selector.contains('+')
        || selector.contains('~')
        || selector.contains('[')
        || selector.contains(':')
        || selector.starts_with('#')
    {
        return None;
    }
    if let Some((element, class_part)) = selector.split_once('.') {
        let class = class_part.split('.').next().filter(|c| !c.is_empty())?;
        let element = if element.is_empty() {
            None
        } else {
            Some(element.to_ascii_lowercase())
        };
        Some((element, Some(class.to_string())))
    } else {
        Some((Some(selector.to_ascii_lowercase()), None))
    }
}

fn parse_css_declarations(block: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for part in split_css_declarations(block) {
        let Some((prop, value)) = part.split_once(':') else {
            continue;
        };
        let prop = prop.trim().to_ascii_lowercase();
        let value = value
            .trim()
            .trim_end_matches(';')
            .trim()
            .trim_end_matches("!important")
            .trim()
            .to_string();
        if !prop.is_empty() && !value.is_empty() {
            out.push((prop, value));
        }
    }
    out
}

fn split_css_declarations(block: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut in_quote: Option<char> = None;
    for ch in block.chars() {
        match (in_quote, ch) {
            (Some(q), c) if c == q => {
                in_quote = None;
                current.push(ch);
            }
            (Some(_), _) => current.push(ch),
            (None, '"' | '\'') => {
                in_quote = Some(ch);
                current.push(ch);
            }
            (None, '(') => {
                depth += 1;
                current.push(ch);
            }
            (None, ')') => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            (None, ';') if depth == 0 => {
                if !current.trim().is_empty() {
                    parts.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

fn css_rule_matches(rule: &AppleCssRule, tag: &str, classes: &[String]) -> bool {
    if let Some(element) = &rule.element {
        if !element.eq_ignore_ascii_case(tag) {
            return false;
        }
    }
    match &rule.class {
        Some(class) => classes.iter().any(|item| item == class),
        None => rule.element.is_some(),
    }
}

fn upsert_decl(decls: &mut Vec<(String, String)>, prop: &str, value: &str) {
    if let Some((_, existing)) = decls.iter_mut().find(|(name, _)| name == prop) {
        *existing = value.to_string();
    } else {
        decls.push((prop.to_string(), value.to_string()));
    }
}

fn css_decl<'a>(declarations: &'a [(String, String)], name: &str) -> Option<&'a str> {
    declarations
        .iter()
        .rev()
        .find(|(prop, _)| prop.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn apply_font_shorthand(marks: &mut AppleCssMarks, font: &str) {
    marks.bold = Some(false);
    marks.italic = Some(false);
    for token in font.split_whitespace() {
        let token = token.trim_end_matches(',');
        if let Some(bold) = parse_font_weight(token) {
            marks.bold = Some(bold);
        }
        if let Some(italic) = parse_font_style(token) {
            marks.italic = Some(italic);
        }
    }
}

fn parse_font_weight(value: &str) -> Option<bool> {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "inherit" | "unset" | "initial" => None,
        "bold" | "bolder" => Some(true),
        "normal" | "lighter" => Some(false),
        _ => value.parse::<u16>().ok().map(|n| n >= 600),
    }
}

fn parse_font_style(value: &str) -> Option<bool> {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "inherit" | "unset" | "initial" => None,
        "italic" | "oblique" => Some(true),
        "normal" => Some(false),
        _ => None,
    }
}

fn apply_text_decoration(marks: &mut AppleCssMarks, value: &str) {
    let lower = value.to_ascii_lowercase();
    if lower.split_whitespace().any(|token| token == "none") {
        marks.underline = Some(false);
        marks.strike = Some(false);
        return;
    }
    marks.underline = Some(lower.split_whitespace().any(|token| token == "underline"));
    marks.strike = Some(
        lower
            .split_whitespace()
            .any(|token| token == "line-through"),
    );
}

fn is_highlight_background(value: &str) -> bool {
    let t = normalize_css_color(value.split_whitespace().next().unwrap_or(value));
    !matches!(
        t.as_str(),
        "none"
            | "transparent"
            | "inherit"
            | "initial"
            | "unset"
            | "white"
            | "#fff"
            | "#ffffff"
            | "rgb(255,255,255)"
            | "rgba(255,255,255,1)"
            | "rgba(255,255,255,1.0)"
    )
}

fn normalize_css_color(value: &str) -> String {
    value
        .trim()
        .trim_end_matches("!important")
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Observed sidecar object keys. Other keys are inventoried, never dropped.
const KNOWN_SIDECAR_KEYS: &[&str] = &["date", "placeName", "visits"];
const KNOWN_VISIT_KEYS: &[&str] = &["placeName", "latitude", "longitude", "city", "typeOfPlace"];

/// Filesystem metadata names excluded from resource inventory (explicit list).
const FILESYSTEM_METADATA_NAMES: &[&str] = &[
    ".DS_Store",
    "._.DS_Store",
    "Thumbs.db",
    "Desktop.ini",
    "desktop.ini",
    ".localized",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".AppleDouble",
    "ehthumbs.db",
];

fn recover_body_text(html: &str, document: &Document) -> String {
    if apple_body_needs_recovery(html, document) {
        tokenize_section_text(html, "bodyText")
    } else if document.select(".bodyText").exists() {
        document.select(".bodyText").formatted_text().to_string()
    } else {
        String::new()
    }
}

pub(crate) fn apple_body_needs_recovery(html: &str, document: &Document) -> bool {
    let parsed = {
        let body = document.select(".bodyText");
        if body.exists() {
            body.formatted_text().to_string()
        } else {
            String::new()
        }
    };
    let tokenized = tokenize_section_text(html, "bodyText");
    should_prefer_tokenizer_body(&parsed, &tokenized)
}

fn should_prefer_tokenizer_body(parsed: &str, tokenized: &str) -> bool {
    let parsed_words: Vec<&str> = parsed.split_whitespace().collect();
    let token_words: Vec<&str> = tokenized.split_whitespace().collect();
    if token_words.is_empty() {
        return false;
    }
    if parsed_words.is_empty() {
        return true;
    }
    parsed_words != token_words
}

/// Tokenizer pass: collect text after the `bodyText` (or other section) open
/// tag in source order, stopping at the next observed section or `</body>`.
/// Does not apply HTML5 implied-close / foster-parenting rules.
fn tokenize_section_text(html: &str, section: &str) -> String {
    apple_section_inner_html(html, section)
        .map(extract_visible_text)
        .unwrap_or_default()
}

/// Raw source slice after a Cocoa section open tag, stopping at the next
/// observed section or `</body>`. Used to recover text that HTML5 tree repair
/// moved out of `.bodyText`.
pub(crate) fn apple_section_inner_html<'a>(html: &'a str, section: &str) -> Option<&'a str> {
    let start = find_class_open_tag_end(html, section)?;
    let rest = &html[start..];
    let end = find_raw_section_end(rest);
    Some(&rest[..end])
}

fn find_class_open_tag_end(html: &str, class: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(rel) = html[offset..].find('<') {
        let abs = offset + rel;
        let after = &html[abs..];
        if after.starts_with("<!--") {
            offset = abs + after.find("-->").map(|n| n + 3).unwrap_or(after.len());
            continue;
        }
        let Some(gt) = after.find('>') else {
            break;
        };
        let tag = &after[..=gt];
        if !tag.starts_with("</") && tag_has_class(tag, class) {
            return Some(abs + gt + 1);
        }
        offset = abs + gt + 1;
    }
    None
}

fn find_raw_section_end(after_open: &str) -> usize {
    let mut offset = 0;
    while let Some(rel) = after_open[offset..].find('<') {
        let abs = offset + rel;
        let after = &after_open[abs..];
        if after.starts_with("<!--") {
            offset = abs + after.find("-->").map(|n| n + 3).unwrap_or(after.len());
            continue;
        }
        let Some(gt) = after.find('>') else {
            break;
        };
        let tag = &after[..=gt];
        let name = tag_name(tag);
        if tag.starts_with("</")
            && (name.eq_ignore_ascii_case("body") || name.eq_ignore_ascii_case("html"))
        {
            return abs;
        }
        if !tag.starts_with("</") {
            for section in OBSERVED_SECTION_CLASSES {
                if tag_has_class(tag, section) {
                    return abs;
                }
            }
        }
        offset = abs + gt + 1;
    }
    after_open.len()
}

fn tag_name(tag: &str) -> String {
    let inner = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_end_matches('>')
        .trim_end_matches('/');
    inner
        .split(|c: char| c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn class_attr(tag: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let idx = lower.find("class=")?;
    let after = tag.get(idx + "class=".len()..)?;
    let quote = after.chars().next()?;
    if quote == '"' || quote == '\'' {
        let rest = &after[quote.len_utf8()..];
        let end = rest.find(quote)?;
        Some(rest[..end].to_string())
    } else {
        Some(
            after
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or("")
                .to_string(),
        )
    }
}

fn tag_has_class(tag: &str, class: &str) -> bool {
    class_attr(tag)
        .map(|classes| {
            classes
                .split_whitespace()
                .any(|item| item.eq_ignore_ascii_case(class))
        })
        .unwrap_or(false)
}

// TODO(later): skip iframe/object/embed like the Yjs walker. See docs/LATER.md.
fn extract_visible_text(html_slice: &str) -> String {
    let mut out = String::new();
    let mut offset = 0;
    let mut skip_raw = false;
    while offset < html_slice.len() {
        if let Some(rel) = html_slice[offset..].find('<') {
            if !skip_raw {
                out.push_str(&decode_entities(&html_slice[offset..offset + rel]));
            }
            let abs = offset + rel;
            let after = &html_slice[abs..];
            if after.starts_with("<!--") {
                offset = abs + after.find("-->").map(|n| n + 3).unwrap_or(after.len());
                continue;
            }
            let Some(gt) = after.find('>') else {
                break;
            };
            let tag = &after[..=gt];
            let name = tag_name(tag);
            let is_end = tag.starts_with("</");
            if name == "script" || name == "style" {
                skip_raw = !is_end;
                offset = abs + gt + 1;
                continue;
            }
            if !skip_raw {
                if name == "br" {
                    out.push('\n');
                } else if !is_end && is_block_tag(&name) && !out.is_empty() && !out.ends_with('\n')
                {
                    out.push('\n');
                }
            }
            offset = abs + gt + 1;
        } else {
            if !skip_raw {
                out.push_str(&decode_entities(&html_slice[offset..]));
            }
            break;
        }
    }
    out
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "tr"
            | "blockquote"
            | "pre"
            | "section"
            | "article"
    )
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        if let Some(semi) = rest.find(';') {
            let entity = &rest[..=semi];
            if let Some(ch) = decode_entity(entity) {
                out.push(ch);
                rest = &rest[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "&nbsp;" | "&#160;" | "&#xA0;" | "&#xa0;" => Some('\u{00a0}'),
        "&amp;" => Some('&'),
        "&lt;" => Some('<'),
        "&gt;" => Some('>'),
        "&quot;" => Some('"'),
        "&apos;" => Some('\''),
        _ if entity.starts_with("&#x") || entity.starts_with("&#X") => {
            let hex = entity.get(3..entity.len() - 1)?;
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        }
        _ if entity.starts_with("&#") => {
            let digits = entity.get(2..entity.len() - 1)?;
            digits.parse::<u32>().ok().and_then(char::from_u32)
        }
        _ => None,
    }
}

fn collect_unknown_cards(html: &str, entry_rel: &Path) -> Vec<AppleJournalUnknownCard> {
    let mut cards: Vec<AppleJournalUnknownCard> = Vec::new();
    let mut rest = html;
    while let Some(idx) = rest.find("assetType_") {
        rest = &rest[idx + "assetType_".len()..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if name.is_empty() {
            continue;
        }
        rest = rest.get(name.len()..).unwrap_or("");
        let folded = name.to_ascii_lowercase();
        if !is_fully_mapped_apple_asset_type(&folded)
            && !cards.iter().any(|c| c.asset_type == folded)
        {
            cards.push(AppleJournalUnknownCard {
                relative_path: entry_rel.to_path_buf(),
                asset_type: folded,
            });
        }
    }
    cards
}

fn is_filesystem_metadata_name(name: &str) -> bool {
    FILESYSTEM_METADATA_NAMES
        .iter()
        .any(|listed| name.eq_ignore_ascii_case(listed))
}

/// Refuse FIFOs, devices, and symlink-to-non-files before `File::open`.
pub(crate) fn assert_regular_file_for_read(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if meta.is_file() {
        return Ok(());
    }
    if meta.file_type().is_symlink() {
        let target = fs::canonicalize(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
        let target_meta =
            fs::symlink_metadata(&target).map_err(|e| format!("stat {}: {e}", path.display()))?;
        if target_meta.is_file() {
            return Ok(());
        }
    }
    Err(format!("not a regular file: {}", path.display()))
}

pub(crate) fn read_text_limited(
    path: &Path,
    max_bytes: u64,
) -> Result<Result<String, u64>, String> {
    assert_regular_file_for_read(path)?;
    let file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let mut limited = file.take(max_bytes.saturating_add(1));
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if buf.len() as u64 > max_bytes {
        return Ok(Err(buf.len() as u64));
    }
    String::from_utf8(buf)
        .map(Ok)
        .map_err(|e| format!("read {}: {e}", path.display()))
}

pub(crate) fn stream_sha256(path: &Path) -> Result<(u64, String), String> {
    assert_regular_file_for_read(path)?;
    let file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let fd_meta = file
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !fd_meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let mut file = file;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex::encode(hasher.finalize())))
}

fn collect_unknown_sidecar_keys(
    value: &serde_json::Value,
    relative_path: &Path,
    out: &mut Vec<AppleJournalUnknownSidecarKey>,
) {
    let Some(obj) = value.as_object() else {
        return;
    };
    for (key, val) in obj {
        if key == "visits" {
            if let Some(visits) = val.as_array() {
                for visit in visits {
                    if let Some(visit_obj) = visit.as_object() {
                        for visit_key in visit_obj.keys() {
                            if !KNOWN_VISIT_KEYS.contains(&visit_key.as_str()) {
                                out.push(AppleJournalUnknownSidecarKey {
                                    relative_path: relative_path.to_path_buf(),
                                    key: visit_key.clone(),
                                });
                            }
                        }
                    }
                }
            }
            continue;
        }
        if !KNOWN_SIDECAR_KEYS.contains(&key.as_str()) {
            out.push(AppleJournalUnknownSidecarKey {
                relative_path: relative_path.to_path_buf(),
                key: key.clone(),
            });
        }
    }
}

fn read_index_entry_hrefs(
    root: &Path,
    index_path: &Path,
    max_html_bytes: u64,
    errors: &mut Vec<AppleJournalScanError>,
) -> Result<Vec<String>, String> {
    match fs::symlink_metadata(index_path) {
        Err(_) => return Ok(Vec::new()),
        Ok(meta) => {
            if meta.file_type().is_symlink() || path_escapes_export_root(root, index_path) {
                errors.push(scan_error(
                    Some(PathBuf::from("index.html")),
                    None,
                    AppleJournalErrorKind::SymlinkEscape,
                    format!(
                        "index.html leaves the export root or is a symlink: {}",
                        index_path.display()
                    ),
                ));
                return Ok(Vec::new());
            }
            if !meta.is_file() {
                return Ok(Vec::new());
            }
        }
    }
    let html = match read_text_limited(index_path, max_html_bytes)? {
        Ok(text) => text,
        Err(len) => {
            errors.push(scan_error(
                Some(PathBuf::from("index.html")),
                None,
                AppleJournalErrorKind::HtmlOverLimit,
                format!(
                    "HTML exceeds {max_html_bytes} bytes ({len}): {}",
                    index_path.display()
                ),
            ));
            return Ok(Vec::new());
        }
    };
    let document = Document::from(html.as_str());
    let mut hrefs = Vec::new();
    for node in document.select("a[href]").iter() {
        if let Some(href) = node.attr("href") {
            let href = href.to_string();
            if is_index_entry_href(&href) {
                hrefs.push(href);
            }
        }
    }
    Ok(hrefs)
}

/// Observed: index links are `Entries/<file>.html`. Exclude `index.html` itself.
fn is_index_entry_href(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    let file_name = href.rsplit(['/', '\\']).next().unwrap_or(href);
    (href.contains("Entries/") || href.contains("entries/"))
        && lower.ends_with(".html")
        && !file_name.eq_ignore_ascii_case("index.html")
}

fn is_entry_html_path(path: &Path) -> bool {
    let is_html = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html"));
    let file_name = path.file_name().and_then(|name| name.to_str());
    is_html && file_name.is_some_and(|name| !name.eq_ignore_ascii_case("index.html"))
}

enum StemBinding<'a> {
    Unique(&'a AppleJournalResource),
    Ambiguous,
}

// TODO(later): reject Windows reserved device names (CON/PRN/AUX/NUL/COM1/LPT1). See docs/LATER.md.
fn inventory_resources(
    root: &Path,
    resources_dir: &Path,
    max_json_bytes: u64,
    errors: &mut Vec<AppleJournalScanError>,
    unknown_sidecar_keys: &mut Vec<AppleJournalUnknownSidecarKey>,
) -> Result<Vec<AppleJournalResource>, String> {
    if !resources_dir.is_dir() {
        return Ok(Vec::new());
    }
    if path_escapes_export_root(root, resources_dir) {
        errors.push(scan_error(
            Some(relative_to(root, resources_dir)),
            None,
            AppleJournalErrorKind::SymlinkEscape,
            format!(
                "Resources directory leaves the export root: {}",
                resources_dir.display()
            ),
        ));
        return Ok(Vec::new());
    }

    let mut paths: Vec<PathBuf> = fs::read_dir(resources_dir)
        .map_err(|e| format!("read Resources: {e}"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| is_inventory_node(path))
        .collect();
    paths.sort();

    let mut sidecar_by_key: HashMap<String, Result<PathBuf, ()>> = HashMap::new();
    let mut media: Vec<(String, PathBuf)> = Vec::new();

    for path in paths {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_filesystem_metadata_name(name) {
            continue;
        }
        if path_escapes_export_root(root, &path) {
            errors.push(scan_error(
                Some(relative_to(root, &path)),
                None,
                AppleJournalErrorKind::SymlinkEscape,
                format!("path leaves the export root: {}", path.display()),
            ));
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name)
            .to_string();
        let is_json = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if is_json {
            if is_leaf_symlink(&path) {
                errors.push(scan_error(
                    Some(relative_to(root, &path)),
                    None,
                    AppleJournalErrorKind::SymlinkEscape,
                    format!("sidecar JSON is a symlink: {}", path.display()),
                ));
                continue;
            }
            validate_sidecar_json(root, &path, max_json_bytes, errors, unknown_sidecar_keys);
            let key = nfc_casefold_key(&stem);
            match sidecar_by_key.get(&key) {
                None => {
                    sidecar_by_key.insert(key, Ok(path));
                }
                Some(Ok(_)) => {
                    errors.push(scan_error(
                        Some(relative_to(root, &path)),
                        None,
                        AppleJournalErrorKind::AmbiguousName,
                        format!("ambiguous sidecar stem '{stem}'"),
                    ));
                    sidecar_by_key.insert(key, Err(()));
                }
                Some(Err(())) => {}
            }
        } else {
            media.push((stem, path));
        }
    }

    Ok(media
        .into_iter()
        .filter_map(|(stem, media_path)| {
            let sidecar_path = sidecar_by_key
                .get(&nfc_casefold_key(&stem))
                .and_then(|bound| bound.as_ref().ok())
                .cloned();
            match stream_sha256(&media_path) {
                Ok((byte_len, sha256)) => Some(AppleJournalResource {
                    stem,
                    media_path,
                    sidecar_path,
                    byte_len,
                    sha256,
                }),
                Err(e) => {
                    errors.push(scan_error(
                        Some(relative_to(root, &media_path)),
                        None,
                        AppleJournalErrorKind::UnreadableResource,
                        format!("unreadable resource '{stem}': {e}"),
                    ));
                    None
                }
            }
        })
        .collect())
}

fn build_resource_lookup<'a>(
    resources: &'a [AppleJournalResource],
    errors: &mut Vec<AppleJournalScanError>,
) -> HashMap<String, StemBinding<'a>> {
    let mut map = HashMap::new();
    for resource in resources {
        let key = nfc_casefold_key(&resource.stem);
        match map.get(&key) {
            None => {
                map.insert(key, StemBinding::Unique(resource));
            }
            Some(StemBinding::Unique(existing)) => {
                errors.push(scan_error(
                    Some(resource.media_path.clone()),
                    None,
                    AppleJournalErrorKind::AmbiguousName,
                    format!(
                        "ambiguous resource name '{}' collides with '{}'",
                        resource.stem, existing.stem
                    ),
                ));
                map.insert(key, StemBinding::Ambiguous);
            }
            Some(StemBinding::Ambiguous) => {}
        }
    }
    map
}

fn bind_media_ref(
    src: &str,
    entry_relative: &Path,
    root: &Path,
    entry_dir: &Path,
    lookup: &HashMap<String, StemBinding<'_>>,
    errors: &mut Vec<AppleJournalScanError>,
) -> Option<AppleJournalMediaRef> {
    let stem = src_stem(src);
    let decoded = match classify_local_src(src) {
        Ok(decoded) => decoded,
        Err(kind) => {
            errors.push(scan_error(
                Some(entry_relative.to_path_buf()),
                Some(src.to_string()),
                kind,
                format!("rejected media src '{src}'"),
            ));
            return None;
        }
    };

    let joined = entry_dir.join(&decoded);
    if path_lexically_escapes(root, &joined) {
        errors.push(scan_error(
            Some(entry_relative.to_path_buf()),
            Some(src.to_string()),
            AppleJournalErrorKind::PathEscape,
            format!("path escapes the export root: {src}"),
        ));
        return None;
    }
    if existing_path_escapes_export_root(root, &joined) {
        errors.push(scan_error(
            Some(entry_relative.to_path_buf()),
            Some(src.to_string()),
            AppleJournalErrorKind::SymlinkEscape,
            format!("symlink leaves the export root: {src}"),
        ));
        return None;
    }

    match lookup.get(&nfc_casefold_key(&stem)) {
        Some(StemBinding::Ambiguous) => {
            errors.push(scan_error(
                Some(entry_relative.to_path_buf()),
                Some(src.to_string()),
                AppleJournalErrorKind::AmbiguousName,
                format!("ambiguous resource stem '{stem}'"),
            ));
            None
        }
        Some(StemBinding::Unique(resource)) => {
            if existing_path_escapes_export_root(root, &resource.media_path) {
                errors.push(scan_error(
                    Some(entry_relative.to_path_buf()),
                    Some(src.to_string()),
                    AppleJournalErrorKind::SymlinkEscape,
                    format!("resource symlink leaves the export root: {src}"),
                ));
                return None;
            }
            Some(AppleJournalMediaRef {
                src: src.to_string(),
                stem,
                media_path: Some(resource.media_path.clone()),
                sidecar_path: resource.sidecar_path.clone(),
            })
        }
        None => Some(AppleJournalMediaRef {
            src: src.to_string(),
            stem,
            media_path: None,
            sidecar_path: None,
        }),
    }
}

pub(crate) fn classify_local_src(src: &str) -> Result<String, AppleJournalErrorKind> {
    let trimmed = src.trim();
    if is_external_src(trimmed) {
        return Err(AppleJournalErrorKind::ExternalUrl);
    }
    let decoded = percent_decode(trimmed);
    let decoded = decoded
        .split(['?', '#'])
        .next()
        .unwrap_or(&decoded)
        .to_string();
    if is_external_src(&decoded) {
        return Err(AppleJournalErrorKind::ExternalUrl);
    }
    if is_absolute_src(&decoded) {
        return Err(AppleJournalErrorKind::AbsolutePath);
    }
    Ok(decoded)
}

fn is_external_src(src: &str) -> bool {
    let lower = src.trim().to_ascii_lowercase();
    if lower.starts_with("//")
        || lower.starts_with("data:")
        || lower.starts_with("javascript:")
        || lower.starts_with("file:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
    {
        return true;
    }
    if let Some(colon) = lower.find(':') {
        let scheme = &lower[..colon];
        if scheme.len() >= 2 && scheme.chars().all(|c| c.is_ascii_alphabetic()) {
            return true;
        }
    }
    false
}

fn is_absolute_src(src: &str) -> bool {
    Path::new(src).is_absolute() || src.starts_with('/') || src.starts_with('\\')
}

fn percent_decode(s: &str) -> String {
    match urlencoding::decode(s) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => s.to_string(),
    }
}

fn src_stem(src: &str) -> String {
    let src = percent_decode(src);
    let src = src.split(['?', '#']).next().unwrap_or(&src);
    let name = src.rsplit(['/', '\\']).next().unwrap_or(src);
    Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string()
}

fn is_inventory_node(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => !meta.is_dir(),
        Err(_) => false,
    }
}

fn path_lexically_escapes(root: &Path, candidate: &Path) -> bool {
    let root_lex = lexical_normalize(root);
    let cand_lex = lexical_normalize(candidate);
    !cand_lex.starts_with(&root_lex)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.push(comp),
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    let _ = out.pop();
                }
                _ => out.push(comp),
            },
            Component::Normal(_) => out.push(comp),
        }
    }
    out
}

fn entry_html_is_unreadable(root: &Path, path: &Path) -> bool {
    is_leaf_symlink(path) || path_escapes_export_root(root, path)
}

pub(crate) fn is_leaf_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(true)
}

/// Fail-closed containment: canonicalize and require the result under `root`.
/// Metadata / canonicalize errors are treated as an escape.
pub(crate) fn path_escapes_export_root(root: &Path, path: &Path) -> bool {
    if path_lexically_escapes(root, path) {
        return true;
    }
    let Ok(root_canon) = fs::canonicalize(root) else {
        return true;
    };
    match fs::canonicalize(path) {
        Ok(canon) => !canon.starts_with(&root_canon),
        Err(_) => true,
    }
}

/// Like [`path_escapes_export_root`], but a missing path is not an escape
/// (bind treats it as unbound rather than a symlink error).
fn existing_path_escapes_export_root(root: &Path, path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Err(_) => false,
        Ok(_) => path_escapes_export_root(root, path),
    }
}

fn validate_sidecar_json(
    root: &Path,
    path: &Path,
    max_json_bytes: u64,
    errors: &mut Vec<AppleJournalScanError>,
    unknown_sidecar_keys: &mut Vec<AppleJournalUnknownSidecarKey>,
) {
    let relative = relative_to(root, path);
    match read_text_limited(path, max_json_bytes) {
        Ok(Ok(text)) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => collect_unknown_sidecar_keys(&value, &relative, unknown_sidecar_keys),
            Err(_) => errors.push(scan_error(
                Some(relative),
                None,
                AppleJournalErrorKind::CorruptSidecar,
                format!("malformed sidecar JSON: {}", path.display()),
            )),
        },
        Ok(Err(len)) => errors.push(scan_error(
            Some(relative),
            None,
            AppleJournalErrorKind::JsonOverLimit,
            format!(
                "JSON exceeds {max_json_bytes} bytes ({len}): {}",
                path.display()
            ),
        )),
        Err(e) => errors.push(scan_error(
            Some(relative),
            None,
            AppleJournalErrorKind::CorruptSidecar,
            format!("unreadable sidecar {e}"),
        )),
    }
}

fn scan_error(
    relative_path: Option<PathBuf>,
    src: Option<String>,
    kind: AppleJournalErrorKind,
    message: String,
) -> AppleJournalScanError {
    AppleJournalScanError {
        relative_path,
        src,
        kind,
        message,
    }
}

fn relative_to(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

/// NFC then Unicode case-fold. NFC/NFD twins and case-only twins share a key.
fn nfc_casefold_key(s: &str) -> String {
    unicode_nfc(s)
        .chars()
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn unicode_nfc(s: &str) -> String {
    s.nfc().collect()
}

/// Version byte mixed into [`apple_source_fingerprint`]. Bump when the
/// canonical payload changes; old imports stay distinct instead of colliding.
pub const APPLE_SOURCE_FINGERPRINT_VERSION: u32 = 1;

/// One sidecar file included in the canonical source fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppleFingerprintSidecar<'a> {
    pub relative_name: &'a str,
    pub json: &'a str,
}

/// One streamed resource hash included in the canonical source fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppleFingerprintResource<'a> {
    pub relative_name: &'a str,
    pub sha256: &'a str,
}

/// Canonical inputs for a versioned Apple Journal source fingerprint.
#[derive(Debug, Clone, Copy)]
pub struct AppleSourceFingerprintParts<'a> {
    pub relative_path: &'a Path,
    pub title: Option<&'a str>,
    pub body_text: &'a str,
    pub raw_html: &'a str,
    pub sidecars: &'a [AppleFingerprintSidecar<'a>],
    pub resources: &'a [AppleFingerprintResource<'a>],
}

/// Normalized entry-relative path used as journal-scoped source identity.
///
/// NFC + case-fold + `/` separators. The export folder name is not included,
/// so renaming the downloaded folder does not change identity.
pub fn apple_source_identity(relative_path: &Path) -> String {
    let raw = relative_path.to_string_lossy().replace('\\', "/");
    let trimmed = raw.trim_start_matches("./");
    nfc_casefold_key(trimmed)
}

/// SHA-256 hex of the versioned canonical source payload.
pub fn apple_source_fingerprint(parts: &AppleSourceFingerprintParts<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"apple-journal-source-fp\0");
    hasher.update(APPLE_SOURCE_FINGERPRINT_VERSION.to_le_bytes());
    hasher.update(b"\0path=");
    hasher.update(apple_source_identity(parts.relative_path).as_bytes());
    hasher.update(b"\0title=");
    hasher.update(parts.title.unwrap_or("").as_bytes());
    hasher.update(b"\0body=");
    hasher.update(parts.body_text.as_bytes());
    hasher.update(b"\0html=");
    hasher.update(sha256_hex(parts.raw_html.as_bytes()).as_bytes());
    fingerprint_named_digests(
        &mut hasher,
        b"\0sidecar=",
        parts
            .sidecars
            .iter()
            .map(|sidecar| (sidecar.relative_name, sha256_hex(sidecar.json.as_bytes()))),
    );
    fingerprint_named_digests(
        &mut hasher,
        b"\0resource=",
        parts
            .resources
            .iter()
            .map(|resource| (resource.relative_name, resource.sha256.to_string())),
    );

    hex::encode(hasher.finalize())
}

fn fingerprint_named_digests<'a, I>(hasher: &mut Sha256, tag: &[u8], items: I)
where
    I: IntoIterator<Item = (&'a str, String)>,
{
    let mut items: Vec<(&str, String)> = items.into_iter().collect();
    items.sort_by(|a, b| nfc_casefold_key(a.0).cmp(&nfc_casefold_key(b.0)));
    for (name, digest) in items {
        hasher.update(tag);
        hasher.update(nfc_casefold_key(name).as_bytes());
        hasher.update(b"=");
        hasher.update(digest.as_bytes());
    }
}

/// Fingerprint one scanned entry using streamed resource hashes and sidecar JSON.
///
/// A sidecar that was readable at scan time but is now unreadable (FIFO,
/// oversize, missing, or not a regular file) is a hard preflight error —
/// never silently dropped from the hash.
pub fn fingerprint_apple_journal_entry(
    entry: &AppleJournalEntry,
    resources: &[AppleJournalResource],
    export_root: &Path,
) -> Result<String, String> {
    let mut sidecar_owned: Vec<(String, String)> = Vec::new();
    for media_ref in &entry.media_refs {
        let Some(path) = media_ref.sidecar_path.as_ref() else {
            continue;
        };
        if is_leaf_symlink(path) || path_escapes_export_root(export_root, path) {
            return Err(format!(
                "Apple Journal preflight: sidecar leaves the export root or is a symlink: {}",
                path.display()
            ));
        }
        let json = match read_text_limited(path, MAX_APPLE_JOURNAL_JSON_BYTES) {
            Ok(Ok(text)) => text,
            Ok(Err(len)) => {
                return Err(format!(
                    "Apple Journal preflight: sidecar exceeds {MAX_APPLE_JOURNAL_JSON_BYTES} bytes ({len}): {}",
                    path.display()
                ));
            }
            Err(e) => {
                return Err(format!(
                    "Apple Journal preflight: unreadable sidecar {}: {e}",
                    path.display()
                ));
            }
        };
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sidecar.json")
            .to_string();
        sidecar_owned.push((name, json));
    }
    let sidecars: Vec<AppleFingerprintSidecar<'_>> = sidecar_owned
        .iter()
        .map(|(name, json)| AppleFingerprintSidecar {
            relative_name: name,
            json,
        })
        .collect();

    let mut resource_owned: Vec<(String, String)> = Vec::new();
    for media_ref in &entry.media_refs {
        let Some(media_path) = media_ref.media_path.as_ref() else {
            resource_owned.push((media_ref.src.clone(), String::new()));
            continue;
        };
        let name = media_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(media_ref.stem.as_str())
            .to_string();
        let digest = resources
            .iter()
            .find(|resource| &resource.media_path == media_path)
            .map(|resource| resource.sha256.clone())
            .unwrap_or_default();
        resource_owned.push((name, digest));
    }
    let fp_resources: Vec<AppleFingerprintResource<'_>> = resource_owned
        .iter()
        .map(|(name, sha256)| AppleFingerprintResource {
            relative_name: name,
            sha256,
        })
        .collect();

    Ok(apple_source_fingerprint(&AppleSourceFingerprintParts {
        relative_path: &entry.relative_path,
        title: entry.title.as_deref(),
        body_text: &entry.body_text,
        raw_html: &entry.raw_html,
        sidecars: &sidecars,
        resources: &fp_resources,
    }))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn write_export(tmp: &Path) {
        fs::create_dir_all(tmp.join("Entries")).unwrap();
        fs::create_dir_all(tmp.join("Resources")).unwrap();

        fs::write(
            tmp.join("index.html"),
            r#"<!DOCTYPE html>
<html><head><title></title></head>
<body>
<p class="p1"><span class="s1"><a href="Entries/2024-03-01.html">Monday, March 1, 2024</a></span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><a href="Entries/2024-03-02_shared.html">Tuesday, March 2, 2024</a></span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><a href="Entries/2024-03-03_Looks_Like_A_Title.html">Wednesday, March 3, 2024</a></span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><a href="Entries/2024-03-04_missing-sidecar.html">Thursday, March 4, 2024</a></span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><a href="Entries/2024-03-05_missing-file.html">Friday, March 5, 2024</a></span></p>
</body></html>
"#,
        )
        .unwrap();

        fs::write(
            tmp.join("Entries/2024-03-01.html"),
            entry_html(
                "Một ngày đẹp trời",
                r#"Xin chào<span class="Apple-converted-space">&nbsp;</span>thế giới &amp; bạn bè.<br>Dòng hai."#,
                &["../Resources/shared-photo.jpg"],
                "ShouldNotUseDocumentTitle",
            ),
        )
        .unwrap();

        fs::write(
            tmp.join("Entries/2024-03-02_shared.html"),
            entry_html(
                "Shared media",
                "Second entry pointing at the same photo.",
                &["../Resources/shared-photo.jpg"],
                "",
            ),
        )
        .unwrap();

        fs::write(
            tmp.join("Entries/2024-03-03_Looks_Like_A_Title.html"),
            entry_html("", "", &[], "Document Title Must Be Ignored"),
        )
        .unwrap();

        fs::write(
            tmp.join("Entries/2024-03-04_missing-sidecar.html"),
            entry_html(
                "Clip",
                "Video without a sidecar.",
                &["../Resources/clip.mov"],
                "",
            ),
        )
        .unwrap();

        fs::write(
            tmp.join("Entries/2024-03-05_missing-file.html"),
            entry_html(
                "Missing file",
                "References a file that is not in Resources.",
                &["../Resources/absent.jpg"],
                "",
            ),
        )
        .unwrap();

        fs::write(tmp.join("Resources/shared-photo.jpg"), b"synthetic-jpeg").unwrap();
        fs::write(tmp.join("Resources/shared-photo.json"), r#"{"date":1}"#).unwrap();
        fs::write(tmp.join("Resources/clip.mov"), b"synthetic-mov").unwrap();
    }

    fn entry_html(title: &str, body: &str, media_srcs: &[&str], document_title: &str) -> String {
        let mut grid = String::new();
        for src in media_srcs {
            let is_video = src.rsplit('.').next().is_some_and(|ext| {
                matches!(ext.to_ascii_lowercase().as_str(), "mov" | "mp4" | "m4v")
            });
            if is_video {
                grid.push_str(&format!(
                    r#"<div class="gridItem assetType_video "><video class="asset_video"><source src="{src}" type="video/mp4"></video></div>"#
                ));
            } else {
                grid.push_str(&format!(
                    r#"<div class="gridItem assetType_photo "><img class="asset_image" src="{src}"></div>"#
                ));
            }
        }
        format!(
            r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{document_title}</title>
<style>
div.pageHeader {{ font-weight: bold; }}
div.title {{ font-weight: bold; }}
div.bodyText {{ }}
div.assetGrid {{ }}
</style>
</head>
<body>
<p class="p1"><span class="s1">
<div>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="assetGrid">{grid}</div>
<div class="title">{title}</div>
<div class="bodyText">{body}</div>
</div>
</span></p>
</body>
</html>
"#
        )
    }

    fn entry<'a>(scan: &'a AppleJournalFolder, file_name: &str) -> &'a AppleJournalEntry {
        scan.entries
            .iter()
            .find(|e| e.relative_path.file_name().and_then(|n| n.to_str()) == Some(file_name))
            .unwrap_or_else(|| panic!("missing entry {file_name}"))
    }

    #[test]
    fn scan_entry_count_excludes_index() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        assert_eq!(scan.entries.len(), 5, "index.html is not an entry");
        assert!(
            !scan
                .entries
                .iter()
                .any(|e| e.relative_path.file_name().and_then(|n| n.to_str())
                    == Some("index.html")),
            "index must not appear in the entry list"
        );
        assert_eq!(scan.index_entry_hrefs.len(), 5, "index hrefs are recorded");
        assert!(
            scan.index_entry_hrefs
                .iter()
                .all(|h| h.starts_with("Entries/") && h.ends_with(".html")),
            "index hrefs stay relative Entries/*.html paths"
        );
    }

    #[test]
    fn parse_empty_title_and_body_ignores_filename_and_document_title() {
        let html = entry_html("", "", &[], "Document Title Must Be Ignored");
        let parsed = parse_apple_entry(&html);
        assert_eq!(parsed.title, None, "empty .title must stay empty");
        assert_eq!(parsed.body_text, "", "empty .bodyText must stay empty");
        assert!(
            parsed.raw_html.contains("Document Title Must Be Ignored"),
            "raw HTML is retained for provenance"
        );

        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let empty = entry(&scan, "2024-03-03_Looks_Like_A_Title.html");
        assert_eq!(
            empty.title, None,
            "must not invent a title from the filename"
        );
        assert_eq!(empty.body_text, "");
        assert_eq!(
            empty.raw_html,
            fs::read_to_string(
                &tmp.path()
                    .join("Entries/2024-03-03_Looks_Like_A_Title.html")
            )
            .unwrap()
        );
    }

    #[test]
    fn parse_vietnamese_entities_converted_space_and_line_breaks() {
        let html = entry_html(
            "Một ngày đẹp trời",
            r#"Xin chào<span class="Apple-converted-space">&nbsp;</span>thế giới &amp; bạn bè.<br>Dòng hai."#,
            &[],
            "ShouldNotUseDocumentTitle",
        );
        let parsed = parse_apple_entry(&html);
        assert_eq!(parsed.title.as_deref(), Some("Một ngày đẹp trời"));
        assert!(
            parsed.body_text.contains("Xin chào"),
            "vietnamese preserved: {}",
            parsed.body_text
        );
        assert!(
            parsed.body_text.contains("thế giới"),
            "vietnamese preserved: {}",
            parsed.body_text
        );
        assert!(
            parsed.body_text.contains("Xin chào thế giới")
                || parsed.body_text.contains("Xin chào\u{00a0}thế giới"),
            "Apple-converted-space is whitespace: {}",
            parsed.body_text
        );
        assert!(
            parsed.body_text.contains("bạn bè") && parsed.body_text.contains('&'),
            "HTML entities decoded: {}",
            parsed.body_text
        );
        assert!(
            !parsed.body_text.contains("&amp;"),
            "ampersand entity must be decoded: {}",
            parsed.body_text
        );
        assert!(
            parsed.body_text.contains('\n') && parsed.body_text.contains("Dòng hai"),
            "br becomes a line break: {}",
            parsed.body_text
        );
    }

    #[test]
    fn scan_one_resource_referenced_by_two_entries() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let first = entry(&scan, "2024-03-01.html");
        let second = entry(&scan, "2024-03-02_shared.html");
        assert_eq!(first.media_refs.len(), 1);
        assert_eq!(second.media_refs.len(), 1);
        assert_eq!(first.media_refs[0].stem, second.media_refs[0].stem);
        assert_eq!(first.media_refs[0].stem, "shared-photo");
        let shared = first.media_refs[0]
            .media_path
            .as_ref()
            .expect("shared media exists");
        assert_eq!(
            second.media_refs[0].media_path.as_ref(),
            Some(shared),
            "both entries bind the same media path"
        );
        assert_eq!(
            first.media_refs[0].sidecar_path,
            second.media_refs[0].sidecar_path
        );
        assert!(
            first.media_refs[0].sidecar_path.is_some(),
            "image sidecar bound by stem"
        );
        let resource = scan
            .resources
            .iter()
            .find(|r| r.stem == "shared-photo")
            .expect("inventory includes shared photo");
        assert_eq!(resource.media_path, *shared);
        assert!(resource.sidecar_path.is_some());
    }

    #[test]
    fn scan_missing_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let clip = &entry(&scan, "2024-03-04_missing-sidecar.html").media_refs[0];
        assert_eq!(clip.stem, "clip");
        assert!(clip.media_path.is_some(), "video file is present");
        assert!(
            clip.sidecar_path.is_none(),
            "observed: videos often have no JSON sidecar"
        );
        let resource = scan
            .resources
            .iter()
            .find(|r| r.stem == "clip")
            .expect("video listed in Resources");
        assert!(resource.sidecar_path.is_none());
    }

    #[test]
    fn scan_missing_referenced_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let missing = &entry(&scan, "2024-03-05_missing-file.html").media_refs[0];
        assert_eq!(missing.stem, "absent");
        assert_eq!(missing.src, "../Resources/absent.jpg");
        assert!(
            missing.media_path.is_none(),
            "referenced file that is not on disk stays unbound"
        );
        assert!(
            !scan.resources.iter().any(|r| r.stem == "absent"),
            "missing files are not invented in the resource inventory"
        );
    }

    fn write_single_entry(tmp: &Path, file_name: &str, title: &str, srcs: &[&str]) {
        fs::create_dir_all(tmp.join("Entries")).unwrap();
        fs::create_dir_all(tmp.join("Resources")).unwrap();
        fs::write(
            tmp.join("index.html"),
            format!(
                r#"<!DOCTYPE html><html><body><a href="Entries/{file_name}">{title}</a></body></html>"#
            ),
        )
        .unwrap();
        fs::write(
            tmp.join("Entries").join(file_name),
            entry_html(title, "synthetic body", srcs, ""),
        )
        .unwrap();
    }

    fn error_kinds(scan: &AppleJournalFolder) -> Vec<AppleJournalErrorKind> {
        scan.errors.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn scan_rejects_path_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let src = "../../tmp/memlore-aj-escape.jpg";
        write_single_entry(tmp.path(), "2024-04-01_escape.html", "Escape", &[src]);
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-01_escape.html");
        assert!(
            item.media_refs.iter().all(|r| r.src != src),
            "escaped src must not be a successful ref: {:?}",
            item.media_refs
        );
        assert!(
            scan.errors.iter().any(|e| {
                e.kind == AppleJournalErrorKind::PathEscape && e.src.as_deref() == Some(src)
            }),
            "path escape must be a per-ref error: {:?}",
            scan.errors
        );
        assert_eq!(scan.entries.len(), 1, "scan must not abort");
    }

    #[test]
    fn scan_rejects_absolute_path() {
        let tmp = tempfile::tempdir().unwrap();
        let src = "/tmp/memlore-aj-absolute.jpg";
        write_single_entry(tmp.path(), "2024-04-02_absolute.html", "Absolute", &[src]);
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-02_absolute.html");
        assert!(
            item.media_refs.iter().all(|r| r.src != src),
            "absolute src must not be a successful ref: {:?}",
            item.media_refs
        );
        assert!(
            scan.errors.iter().any(|e| {
                e.kind == AppleJournalErrorKind::AbsolutePath && e.src.as_deref() == Some(src)
            }),
            "absolute path must be a per-ref error: {:?}",
            scan.errors
        );
    }

    #[test]
    fn scan_rejects_external_url() {
        let tmp = tempfile::tempdir().unwrap();
        let src = "https://example.invalid/tracker.jpg";
        write_single_entry(tmp.path(), "2024-04-03_remote.html", "Remote", &[src]);
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-03_remote.html");
        assert!(
            item.media_refs.iter().all(|r| r.src != src),
            "external URL must not be a successful ref: {:?}",
            item.media_refs
        );
        assert!(
            scan.errors.iter().any(|e| {
                e.kind == AppleJournalErrorKind::ExternalUrl && e.src.as_deref() == Some(src)
            }),
            "external URL must be a per-ref error: {:?}",
            scan.errors
        );
    }

    #[test]
    fn scan_rejects_symlink_outside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let export = tmp.path().join("export");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.jpg"), b"outside-bytes").unwrap();
        write_single_entry(
            &export,
            "2024-04-04_symlink.html",
            "Symlink",
            &["../Resources/secret.jpg"],
        );
        std::os::unix::fs::symlink(
            outside.join("secret.jpg"),
            export.join("Resources/secret.jpg"),
        )
        .unwrap();

        let scan = scan_apple_journal_folder(&export).expect("scan continues");
        let item = entry(&scan, "2024-04-04_symlink.html");
        assert!(
            item.media_refs
                .iter()
                .all(|r| r.src != "../Resources/secret.jpg"),
            "symlink leaving the root must not be a successful ref: {:?}",
            item.media_refs
        );
        assert!(
            !scan.resources.iter().any(|r| r.stem == "secret"),
            "escaped symlink must not be a successful resource: {:?}",
            scan.resources
        );
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::SymlinkEscape),
            "symlink escape must be reported: {:?}",
            scan.errors
        );
    }

    #[test]
    fn scan_rejects_directory_symlink_outside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let export = tmp.path().join("export");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.jpg"), b"outside-via-dir-symlink").unwrap();
        fs::create_dir_all(export.join("Entries")).unwrap();
        fs::write(
            export.join("index.html"),
            r#"<!DOCTYPE html><html><body><a href="Entries/2024-04-07_dirlink.html">Dir</a></body></html>"#,
        )
        .unwrap();
        fs::write(
            export.join("Entries/2024-04-07_dirlink.html"),
            entry_html(
                "Dirlink",
                "synthetic body",
                &["../Resources/secret.jpg"],
                "",
            ),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, export.join("Resources")).unwrap();

        let scan = scan_apple_journal_folder(&export).expect("scan continues");
        assert!(
            scan.errors.is_empty() == false
                && error_kinds(&scan).contains(&AppleJournalErrorKind::SymlinkEscape),
            "parent-directory symlink leaving the root must be reported: {:?}",
            scan.errors
        );
        assert!(
            !scan.resources.iter().any(|r| r.stem == "secret"),
            "outside-root file reached via Resources/ directory symlink must not be inventoried: {:?}",
            scan.resources
        );
        let item = entry(&scan, "2024-04-07_dirlink.html");
        assert!(
            item.media_refs
                .iter()
                .all(|r| r.src != "../Resources/secret.jpg" || r.media_path.is_none()),
            "directory-symlink escape must not bind: {:?}",
            item.media_refs
        );
        assert!(
            item.raw_html.contains("outside-via-dir-symlink") == false,
            "scanner must not ingest bytes from outside the export root"
        );
    }

    #[test]
    fn scan_rejects_entry_html_leaf_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let export = tmp.path().join("export");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("secret.html"),
            "<html><body>LEAF-SYMLINK-SECRET</body></html>",
        )
        .unwrap();
        fs::create_dir_all(export.join("Entries")).unwrap();
        fs::create_dir_all(export.join("Resources")).unwrap();
        fs::write(
            export.join("index.html"),
            r#"<!DOCTYPE html><html><body><a href="Entries/2024-01-01.html">Leaf</a></body></html>"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.join("secret.html"),
            export.join("Entries/2024-01-01.html"),
        )
        .unwrap();

        let scan = scan_apple_journal_folder(&export).expect("scan continues");
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::SymlinkEscape),
            "leaf HTML symlink must be reported: {:?}",
            scan.errors
        );
        assert!(
            !scan.entries.iter().any(|e| {
                e.relative_path.file_name().and_then(|n| n.to_str()) == Some("2024-01-01.html")
            }),
            "symlinked entry HTML must not be parsed: {:?}",
            scan.entries
                .iter()
                .map(|e| e.relative_path.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            !scan
                .entries
                .iter()
                .any(|e| e.raw_html.contains("LEAF-SYMLINK-SECRET")),
            "secret target of an entry HTML symlink must not be read into raw_html"
        );
    }

    #[test]
    fn scan_rejects_index_html_leaf_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let export = tmp.path().join("export");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("index.html"),
            r#"<!DOCTYPE html><html><body><a href="Entries/INDEX-SYMLINK-SECRET.html">x</a></body></html>"#,
        )
        .unwrap();
        fs::create_dir_all(export.join("Entries")).unwrap();
        fs::create_dir_all(export.join("Resources")).unwrap();
        fs::write(
            export.join("Entries/2024-01-02.html"),
            entry_html("Index leaf", "body", &[], ""),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.join("index.html"), export.join("index.html")).unwrap();

        let scan = scan_apple_journal_folder(&export).expect("scan continues");
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::SymlinkEscape),
            "index.html leaf symlink must be reported: {:?}",
            scan.errors
        );
        assert!(
            !scan
                .index_entry_hrefs
                .iter()
                .any(|h| h.contains("INDEX-SYMLINK-SECRET")),
            "symlinked index.html must not be read: {:?}",
            scan.index_entry_hrefs
        );
    }

    #[test]
    fn scan_fifo_resource_is_error_not_empty_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-04-08_fifo.html",
            "Fifo",
            &["../Resources/pipe.bin"],
        );
        let fifo = tmp.path().join("Resources/pipe.bin");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo");
        assert!(status.success(), "mkfifo {fifo:?}");

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::UnreadableResource),
            "non-regular / unreadable media must be a per-file error: {:?}",
            scan.errors
        );
        assert!(
            !scan
                .resources
                .iter()
                .any(|r| r.stem == "pipe" && r.sha256.is_empty()),
            "empty digest must not be stored as a successful inventory: {:?}",
            scan.resources
        );
        assert!(
            !scan.resources.iter().any(|r| r.stem == "pipe"),
            "FIFO must not be inventoried as a successful resource: {:?}",
            scan.resources
        );
    }

    fn make_fifo(path: &Path) {
        let status = std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .expect("mkfifo");
        assert!(status.success(), "mkfifo {path:?}");
    }

    #[test]
    fn regular_file_check_rejects_fifo_without_opening() {
        let tmp = tempfile::tempdir().unwrap();
        let fifo = tmp.path().join("pipe.bin");
        make_fifo(&fifo);
        let err = assert_regular_file_for_read(&fifo).expect_err("FIFO must be refused");
        assert!(
            err.contains("not a regular file"),
            "FIFO refusal should not open the pipe: {err}"
        );
    }

    #[test]
    fn regular_file_check_rejects_symlink_to_fifo_without_opening() {
        let tmp = tempfile::tempdir().unwrap();
        let fifo = tmp.path().join("real.pipe");
        let link = tmp.path().join("pipe.bin");
        make_fifo(&fifo);
        std::os::unix::fs::symlink(&fifo, &link).unwrap();
        let err = assert_regular_file_for_read(&link).expect_err("symlink-to-FIFO must be refused");
        assert!(
            err.contains("not a regular file"),
            "symlink-to-FIFO must fail before File::open: {err}"
        );
    }

    #[test]
    fn scan_fifo_entry_html_is_per_file_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(tmp.path(), "2024-04-09_ok.html", "Ok", &[]);
        make_fifo(&tmp.path().join("Entries/2024-04-09_fifo.html"));

        let scan =
            scan_apple_journal_folder(tmp.path()).expect("FIFO HTML must not abort the scan");
        assert_eq!(scan.entries.len(), 1, "readable entries stay parsed");
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::UnreadableResource),
            "FIFO entry HTML is a per-file error: {:?}",
            scan.errors
        );
        assert!(
            scan.entries
                .iter()
                .all(|e| e.relative_path.file_name().and_then(|n| n.to_str())
                    != Some("2024-04-09_fifo.html")),
            "FIFO HTML must not populate raw_html: {:?}",
            scan.entries
        );
    }

    #[test]
    fn scan_symlink_to_fifo_resource_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-04-10_fifo-link.html",
            "Fifo link",
            &["../Resources/pipe.bin"],
        );
        let fifo = tmp.path().join("Resources/real.pipe");
        make_fifo(&fifo);
        std::os::unix::fs::symlink(&fifo, tmp.path().join("Resources/pipe.bin")).unwrap();

        let scan =
            scan_apple_journal_folder(tmp.path()).expect("symlink-to-FIFO must not abort the scan");
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::UnreadableResource),
            "symlink-to-FIFO must be a per-file error: {:?}",
            scan.errors
        );
        assert!(
            !scan.resources.iter().any(|r| r.stem == "pipe"),
            "symlink-to-FIFO must not be inventoried: {:?}",
            scan.resources
        );
    }

    #[test]
    fn scan_corrupt_sidecar_is_per_file_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        fs::write(tmp.path().join("Resources/shared-photo.json"), "{not-json").unwrap();
        fs::write(tmp.path().join("Resources/ok-photo.jpg"), b"ok").unwrap();
        fs::write(tmp.path().join("Resources/ok-photo.json"), r#"{"date":2}"#).unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("corrupt JSON must not abort");
        assert_eq!(scan.entries.len(), 5, "other entries stay parsed");
        assert!(
            scan.errors.iter().any(|e| {
                e.kind == AppleJournalErrorKind::CorruptSidecar
                    && e.relative_path
                        .as_ref()
                        .is_some_and(|p| p.ends_with("shared-photo.json"))
            }),
            "corrupt sidecar is a per-file error: {:?}",
            scan.errors
        );
        assert!(
            scan.resources.iter().any(|r| r.stem == "ok-photo"),
            "valid resources remain inventoried"
        );
        let clip = &entry(&scan, "2024-03-04_missing-sidecar.html").media_refs[0];
        assert!(clip.media_path.is_some(), "unrelated media still binds");
    }

    #[test]
    fn scan_nfc_nfd_collision_is_ambiguous() {
        let tmp = tempfile::tempdir().unwrap();
        let nfc_stem = "cafe\u{00e9}";
        let nfd_stem = "cafe\u{0065}\u{0301}";
        write_single_entry(
            tmp.path(),
            "2024-04-05_nfc.html",
            "NFC",
            &[&format!("../Resources/{nfc_stem}.jpg")],
        );
        fs::write(
            tmp.path().join("Resources").join(format!("{nfc_stem}.jpg")),
            b"nfc",
        )
        .unwrap();
        fs::write(
            tmp.path().join("Resources").join(format!("{nfd_stem}.png")),
            b"nfd",
        )
        .unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-05_nfc.html");
        assert!(
            item.media_refs.iter().all(|r| r.media_path.is_none()),
            "NFC/NFD twins must not be guessed: {:?}",
            item.media_refs
        );
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::AmbiguousName),
            "NFC/NFD collision is ambiguous: {:?}",
            scan.errors
        );
    }

    #[test]
    fn scan_case_only_collision_is_ambiguous() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-04-06_case.html",
            "Case",
            &["../Resources/Photo.jpg"],
        );
        fs::write(tmp.path().join("Resources/Photo.jpg"), b"upper").unwrap();
        fs::write(tmp.path().join("Resources/photo.png"), b"lower").unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-06_case.html");
        assert!(
            item.media_refs.iter().all(|r| r.media_path.is_none()),
            "case-only twins must not be guessed: {:?}",
            item.media_refs
        );
        assert!(
            error_kinds(&scan).contains(&AppleJournalErrorKind::AmbiguousName),
            "case-only collision is ambiguous: {:?}",
            scan.errors
        );
    }

    #[test]
    fn viet_nfd_composes_to_nfc_lookup_key() {
        let nfc = "Vi\u{1ec7}t";
        let nfd = "Vie\u{0323}\u{0302}t";
        assert_ne!(
            nfc.as_bytes(),
            nfd.as_bytes(),
            "fixture must use distinct NFC vs NFD byte sequences"
        );
        assert_eq!(
            nfc_casefold_key(nfc),
            nfc_casefold_key(nfd),
            "UAX #15 NFC must compose e+U+0323+U+0302 to ệ, not stop at ẹ"
        );
    }

    #[test]
    fn scan_viet_nfc_html_binds_nfd_file() {
        let tmp = tempfile::tempdir().unwrap();
        let nfc = "Vi\u{1ec7}t";
        let nfd = "Vie\u{0323}\u{0302}t";
        write_single_entry(
            tmp.path(),
            "2024-04-09_viet.html",
            "Viet",
            &[&format!("../Resources/{nfc}.jpg")],
        );
        fs::write(
            tmp.path().join("Resources").join(format!("{nfd}.jpg")),
            b"viet-bytes",
        )
        .unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan continues");
        let item = entry(&scan, "2024-04-09_viet.html");
        assert!(
            item.media_refs.iter().any(|r| r.media_path.is_some()),
            "Việt.jpg NFC src must bind the NFD file: refs={:?} errors={:?} resources={:?}",
            item.media_refs,
            scan.errors,
            scan.resources
                .iter()
                .map(|r| (r.stem.clone(), r.sha256.clone()))
                .collect::<Vec<_>>()
        );
        assert!(
            !scan
                .unreferenced_resources
                .iter()
                .any(|r| r.stem == nfd || r.stem == nfc),
            "bound Việt.jpg must not be marked unreferenced: {:?}",
            scan.unreferenced_resources
        );
    }

    fn malformed_cocoa_html() -> String {
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title></title>
<style>
div.pageHeader { font-weight: bold; }
div.title { font-weight: bold; }
div.bodyText { }
</style>
</head>
<body>
<p class="p1"><span class="s1">
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="title">Cocoa nest</div>
<p class="p2 bodyText"><span class="s2">Alpha</span>
<div class="repaired-wrapper">
<p class="p3"><span class="s3">Bravo</span></p>
</div>
<p class="p4"><span class="s4">Charlie</span></p>
</span></p>
</span></p>
</body>
</html>
"#
        .to_string()
    }

    #[test]
    fn parse_malformed_cocoa_nesting_keeps_text_order() {
        let parsed = parse_apple_entry(&malformed_cocoa_html());
        let collapsed = parsed
            .body_text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            collapsed.contains("Alpha")
                && collapsed.contains("Bravo")
                && collapsed.contains("Charlie"),
            "DOM repair must not drop body text: {:?}",
            parsed.body_text
        );
        let alpha = collapsed.find("Alpha").expect("Alpha");
        let bravo = collapsed.find("Bravo").expect("Bravo");
        let charlie = collapsed.find("Charlie").expect("Charlie");
        assert!(
            alpha < bravo && bravo < charlie,
            "malformed Cocoa nesting must keep source text order: {:?}",
            parsed.body_text
        );
        assert_eq!(parsed.title.as_deref(), Some("Cocoa nest"));
    }

    #[test]
    fn parse_empty_repaired_body_wrapper_recovers_following_text() {
        let html = r#"<!DOCTYPE html>
<html><body>
<div class="title">Wrap</div>
<p class="p1 bodyText"><div class="repaired-wrapper"><p>Recovered</p></div>Trailing</p>
</body></html>
"#;
        let parsed = parse_apple_entry(html);
        let collapsed = parsed
            .body_text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            collapsed.contains("Recovered") && collapsed.contains("Trailing"),
            "must not emit an empty body when text follows a repaired wrapper: {:?}",
            parsed.body_text
        );
    }

    #[test]
    fn scan_html_over_limit_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(tmp.path(), "2024-05-01_html.html", "Over", &[]);
        let limits = AppleJournalScanLimits {
            max_html_bytes: 32,
            max_json_bytes: 64 * 1024,
        };
        let scan = scan_apple_journal_folder_with_limits(tmp.path(), limits)
            .expect("oversized HTML is a per-file error");
        assert!(
            scan.errors
                .iter()
                .any(|e| e.kind == AppleJournalErrorKind::HtmlOverLimit),
            "HTML over limit must be reported: {:?}",
            scan.errors
        );
        assert!(
            scan.entries
                .iter()
                .all(|e| e.relative_path.file_name().and_then(|n| n.to_str())
                    != Some("2024-05-01_html.html")),
            "oversized HTML must not be parsed as an entry"
        );
    }

    #[test]
    fn scan_json_over_limit_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-05-02_json.html",
            "Json",
            &["../Resources/sidecar-photo.jpg"],
        );
        fs::write(tmp.path().join("Resources/sidecar-photo.jpg"), b"img").unwrap();
        fs::write(
            tmp.path().join("Resources/sidecar-photo.json"),
            format!("{{\"date\":1,\"pad\":\"{}\"}}", "x".repeat(80)),
        )
        .unwrap();
        let limits = AppleJournalScanLimits {
            max_html_bytes: 64 * 1024,
            max_json_bytes: 16,
        };
        let scan = scan_apple_journal_folder_with_limits(tmp.path(), limits)
            .expect("oversized JSON is a per-file error");
        assert!(
            scan.errors.iter().any(|e| {
                e.kind == AppleJournalErrorKind::JsonOverLimit
                    && e.relative_path
                        .as_ref()
                        .is_some_and(|p| p.ends_with("sidecar-photo.json"))
            }),
            "JSON over limit must be a per-file error: {:?}",
            scan.errors
        );
        assert_eq!(scan.entries.len(), 1, "scan must not abort");
        let media = &entry(&scan, "2024-05-02_json.html").media_refs[0];
        assert!(media.media_path.is_some(), "media still binds");
    }

    #[test]
    fn scan_media_larger_than_html_limit_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-05-03_big-media.html",
            "Big media",
            &["../Resources/clip-large.mov"],
        );
        let media_bytes = vec![b'M'; 8 * 1024];
        fs::write(tmp.path().join("Resources/clip-large.mov"), &media_bytes).unwrap();
        let limits = AppleJournalScanLimits {
            max_html_bytes: 1024,
            max_json_bytes: 1024,
        };
        let entry_len = fs::metadata(tmp.path().join("Entries/2024-05-03_big-media.html"))
            .unwrap()
            .len();
        assert!(
            entry_len <= limits.max_html_bytes,
            "test HTML must stay under the small HTML limit ({entry_len} > {})",
            limits.max_html_bytes
        );
        assert!(
            media_bytes.len() as u64 > limits.max_html_bytes,
            "media must exceed the HTML limit"
        );

        let scan = scan_apple_journal_folder_with_limits(tmp.path(), limits).expect("scan");
        assert!(
            !scan
                .errors
                .iter()
                .any(|e| e.kind == AppleJournalErrorKind::HtmlOverLimit),
            "media size must not use the HTML limit: {:?}",
            scan.errors
        );
        let resource = scan
            .resources
            .iter()
            .find(|r| r.stem == "clip-large")
            .expect("large media stays inventoried");
        assert_eq!(resource.byte_len, media_bytes.len() as u64);
        assert_eq!(
            resource.sha256,
            {
                use sha2::{Digest, Sha256};
                hex::encode(Sha256::digest(&media_bytes))
            },
            "media is hashed by streaming, not dropped"
        );
        let bound = &entry(&scan, "2024-05-03_big-media.html").media_refs[0];
        assert!(bound.media_path.is_some(), "large media still binds");
    }

    #[test]
    fn scan_unreferenced_resource_is_inventoried() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        fs::write(tmp.path().join("Resources/orphan-photo.jpg"), b"orphan").unwrap();
        fs::write(
            tmp.path().join("Resources/orphan-photo.json"),
            r#"{"date":9}"#,
        )
        .unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        assert!(
            scan.resources.iter().any(|r| r.stem == "orphan-photo"),
            "unreferenced media must stay in the resource list"
        );
        assert!(
            scan.unreferenced_resources
                .iter()
                .any(|r| r.stem == "orphan-photo"),
            "unreferenced resource must be inventoried: {:?}",
            scan.unreferenced_resources
        );
        assert!(
            !scan
                .unreferenced_resources
                .iter()
                .any(|r| r.stem == "shared-photo"),
            "referenced media is not an orphan"
        );
    }

    #[test]
    fn scan_unknown_card_is_inventoried() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("Entries")).unwrap();
        fs::create_dir_all(tmp.path().join("Resources")).unwrap();
        fs::write(tmp.path().join("index.html"), "<html></html>").unwrap();
        let html = r#"<!DOCTYPE html>
<html>
<head><title></title>
<style>div.title { } div.bodyText { }</style>
</head>
<body>
<div class="title">Unknown card</div>
<div class="assetGrid">
<div class="gridItem assetType_reflection "><span>synthetic card</span></div>
</div>
<div class="bodyText">After the card.</div>
</body>
</html>
"#;
        fs::write(
            tmp.path().join("Entries/2024-05-04_unknown-card.html"),
            html,
        )
        .unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        assert!(
            scan.unknown_cards.iter().any(|card| {
                card.asset_type == "reflection"
                    && card.relative_path.ends_with("2024-05-04_unknown-card.html")
            }),
            "unknown card must be inventoried: {:?}",
            scan.unknown_cards
        );
        let item = entry(&scan, "2024-05-04_unknown-card.html");
        assert!(
            item.body_text.contains("After the card"),
            "unknown card must not drop surrounding body: {:?}",
            item.body_text
        );
    }

    #[test]
    fn scan_limited_asset_types_are_inventoried_as_unknown_cards() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("Entries")).unwrap();
        fs::create_dir_all(tmp.path().join("Resources")).unwrap();
        fs::write(tmp.path().join("index.html"), "<html></html>").unwrap();
        let html = r#"<!DOCTYPE html>
<html><body>
<div class="title">Limited cards</div>
<div class="assetGrid">
<div class="gridItem assetType_drawing "><span>drawing caption</span></div>
<div class="gridItem assetType_location "><span>location caption</span></div>
<div class="gridItem assetType_livephoto "><span>live caption</span></div>
</div>
<div class="bodyText">After limited cards.</div>
</body></html>
"#;
        fs::write(tmp.path().join("Entries/2024-05-06_limited.html"), html).unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        for asset_type in ["drawing", "location", "livephoto"] {
            assert!(
                scan.unknown_cards
                    .iter()
                    .any(|card| card.asset_type == asset_type),
                "limited type {asset_type} must be inventoried, not treated as fully mapped: {:?}",
                scan.unknown_cards
            );
        }
        let item = entry(&scan, "2024-05-06_limited.html");
        assert!(
            item.body_text.contains("After limited cards"),
            "limited cards must not drop surrounding body: {:?}",
            item.body_text
        );
    }

    #[test]
    fn scan_unknown_sidecar_key_is_inventoried() {
        let tmp = tempfile::tempdir().unwrap();
        write_single_entry(
            tmp.path(),
            "2024-05-05_keys.html",
            "Keys",
            &["../Resources/known-photo.jpg"],
        );
        fs::write(tmp.path().join("Resources/known-photo.jpg"), b"img").unwrap();
        fs::write(
            tmp.path().join("Resources/known-photo.json"),
            r#"{"date":1,"mysteryField":true}"#,
        )
        .unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        assert!(
            scan.unknown_sidecar_keys.iter().any(|k| {
                k.key == "mysteryField" && k.relative_path.ends_with("known-photo.json")
            }),
            "unknown sidecar key must be inventoried: {:?}",
            scan.unknown_sidecar_keys
        );
        assert!(
            !scan.unknown_sidecar_keys.iter().any(|k| k.key == "date"),
            "observed date key is not unknown: {:?}",
            scan.unknown_sidecar_keys
        );
    }

    #[test]
    fn scan_ds_store_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        fs::write(tmp.path().join("Resources/.DS_Store"), b"fs-metadata").unwrap();
        fs::write(tmp.path().join(".DS_Store"), b"root-fs-metadata").unwrap();

        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        assert!(
            !scan.resources.iter().any(|r| {
                r.media_path.file_name().and_then(|n| n.to_str()) == Some(".DS_Store")
            }),
            ".DS_Store must not be inventoried as media: {:?}",
            scan.resources
        );
        assert!(
            !scan.unreferenced_resources.iter().any(|r| {
                r.media_path.file_name().and_then(|n| n.to_str()) == Some(".DS_Store")
            }),
            ".DS_Store must not appear as an orphan"
        );
        assert!(
            !scan.errors.iter().any(|e| {
                e.relative_path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    == Some(".DS_Store")
            }),
            ".DS_Store must not be an error: {:?}",
            scan.errors
        );
    }

    #[test]
    fn stylesheet_maps_class_and_inline_allowlist() {
        let html = r#"<style>
span.sBold {font-weight: bold; font-style: normal}
span.sPaint {color: #c41e3a}
span.sMark {background-color: #fff3b0; text-decoration: underline}
p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 18.0px '.AppleSystemUIFont'; color: #000000}
</style>
<p class="p1"><span class="sBold">x</span></p>"#;
        let rules = parse_apple_stylesheet(html);
        let bold = collect_element_declarations(&rules, "span", &[String::from("sBold")], None);
        let marks = resolve_apple_css_marks(&bold);
        assert_eq!(marks.bold, Some(true), "class font-weight:bold: {bold:?}");
        assert_eq!(marks.italic, Some(false));

        let painted = collect_element_declarations(&rules, "span", &[String::from("sPaint")], None);
        assert_eq!(
            extract_non_default_font_color(&painted).as_deref(),
            Some("#c41e3a")
        );

        let highlight = collect_element_declarations(
            &rules,
            "span",
            &[String::from("sMark")],
            Some("text-decoration: line-through"),
        );
        let hi = resolve_apple_css_marks(&highlight);
        assert_eq!(hi.highlight, Some(true));
        assert_eq!(
            hi.strike,
            Some(true),
            "inline text-decoration overrides class"
        );
        assert_eq!(hi.underline, Some(false));

        let paragraph = collect_element_declarations(&rules, "p", &[String::from("p1")], None);
        assert_eq!(
            extract_non_default_font_color(&paragraph),
            None,
            "document-default black is not a conversion colour: {paragraph:?}"
        );
        assert!(is_default_document_color("#000000"));
        assert!(!is_default_document_color("#c41e3a"));
    }

    #[test]
    fn inherited_bold_merges_and_normal_overrides() {
        let parent = AppleCssMarks {
            bold: Some(true),
            ..AppleCssMarks::default()
        };
        let inherited = AppleCssMarks::merge_inherited(parent, AppleCssMarks::default());
        assert_eq!(inherited.bold, Some(true));
        let overridden = AppleCssMarks::merge_inherited(
            parent,
            AppleCssMarks {
                bold: Some(false),
                ..AppleCssMarks::default()
            },
        );
        assert_eq!(overridden.bold, Some(false));
    }

    #[test]
    fn unknown_asset_type_is_not_known() {
        assert!(is_known_apple_asset_type("photo"));
        assert!(is_known_apple_asset_type("Drawing"));
        assert!(!is_known_apple_asset_type("reflection"));
        assert_eq!(
            apple_asset_type_from_class("gridItem assetType_reflection ").as_deref(),
            Some("reflection")
        );
    }

    use chrono::{
        Datelike, FixedOffset, MappedLocalTime, NaiveDate, NaiveDateTime, TimeDelta, TimeZone,
        Timelike, Utc, Weekday,
    };

    const IMPORT_BOOKKEEPING_TS: i64 = 1_700_000_000;

    fn ymd(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("valid fixture date")
    }

    fn resolve_in_utc(html: &str, source_name: &str) -> AppleResolvedEntryDate {
        resolve_apple_entry_date(html, source_name, &Utc, "UTC", IMPORT_BOOKKEEPING_TS)
    }

    fn has_warning(resolved: &AppleResolvedEntryDate, kind: AppleDateWarningKind) -> bool {
        resolved.warnings.iter().any(|warning| warning.kind == kind)
    }

    /// US Eastern DST rules since 2007, for timezone-aware tests only.
    /// This is the conversion timezone under test — not an Apple export field.
    #[derive(Clone, Copy, Debug)]
    struct UsEastern;

    fn est() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }

    fn edt() -> FixedOffset {
        FixedOffset::west_opt(4 * 3600).unwrap()
    }

    fn nth_weekday(year: i32, month: u32, weekday: Weekday, n: u8) -> NaiveDate {
        let mut date = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
        let mut seen = 0u8;
        loop {
            if date.weekday() == weekday {
                seen += 1;
                if seen == n {
                    return date;
                }
            }
            date = date.succ_opt().unwrap();
            if date.month() != month {
                panic!("weekday {weekday:?} #{n} missing in {year}-{month}");
            }
        }
    }

    fn us_eastern_is_edt_utc(utc: NaiveDateTime) -> bool {
        let year = utc.year();
        let spring = nth_weekday(year, 3, Weekday::Sun, 2)
            .and_hms_opt(7, 0, 0)
            .unwrap();
        let fall = nth_weekday(year, 11, Weekday::Sun, 1)
            .and_hms_opt(6, 0, 0)
            .unwrap();
        utc >= spring && utc < fall
    }

    fn naive_utc_for_offset(local: NaiveDateTime, offset: FixedOffset) -> NaiveDateTime {
        local - TimeDelta::seconds(i64::from(offset.local_minus_utc()))
    }

    impl TimeZone for UsEastern {
        type Offset = FixedOffset;

        fn from_offset(_offset: &Self::Offset) -> Self {
            UsEastern
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            let est_ok = !us_eastern_is_edt_utc(naive_utc_for_offset(*local, est()));
            let edt_ok = us_eastern_is_edt_utc(naive_utc_for_offset(*local, edt()));
            match (est_ok, edt_ok) {
                (false, false) => MappedLocalTime::None,
                (true, false) => MappedLocalTime::Single(est()),
                (false, true) => MappedLocalTime::Single(edt()),
                (true, true) => MappedLocalTime::Ambiguous(edt(), est()),
            }
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            if us_eastern_is_edt_utc(*utc) {
                edt()
            } else {
                est()
            }
        }
    }

    /// Conversion zone whose local noon never exists. Tests rejection, not a real TZ.
    #[derive(Clone, Copy, Debug)]
    struct NoonDoesNotExist;

    impl TimeZone for NoonDoesNotExist {
        type Offset = FixedOffset;

        fn from_offset(_offset: &Self::Offset) -> Self {
            NoonDoesNotExist
        }

        fn offset_from_local_date(&self, _local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            MappedLocalTime::Single(FixedOffset::east_opt(0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            if local.hour() == 12 && local.minute() == 0 && local.second() == 0 {
                MappedLocalTime::None
            } else {
                MappedLocalTime::Single(FixedOffset::east_opt(0).unwrap())
            }
        }

        fn offset_from_utc_date(&self, _utc: &NaiveDate) -> FixedOffset {
            FixedOffset::east_opt(0).unwrap()
        }

        fn offset_from_utc_datetime(&self, _utc: &NaiveDateTime) -> FixedOffset {
            FixedOffset::east_opt(0).unwrap()
        }
    }

    #[test]
    fn header_wins_on_three_synthetic_mismatches() {
        let cases = [
            (
                "Entries/2024-06-14_synthetic-mismatch-a.html",
                include_str!(
                    "../tests/fixtures/apple-journal/Entries/2024-06-14_synthetic-mismatch-a.html"
                ),
                ymd(2024, 6, 15),
                ymd(2024, 6, 14),
                "Saturday, June 15, 2024",
            ),
            (
                "Entries/2024-11-30_synthetic-mismatch-b.html",
                include_str!(
                    "../tests/fixtures/apple-journal/Entries/2024-11-30_synthetic-mismatch-b.html"
                ),
                ymd(2024, 12, 1),
                ymd(2024, 11, 30),
                "Sunday, December 1, 2024",
            ),
            (
                "Entries/2023-02-28_synthetic-mismatch-c.html",
                include_str!(
                    "../tests/fixtures/apple-journal/Entries/2023-02-28_synthetic-mismatch-c.html"
                ),
                ymd(2023, 3, 1),
                ymd(2023, 2, 28),
                "Wednesday, March 1, 2023",
            ),
        ];
        for (source_name, html, header, filename, header_raw) in cases {
            let resolved = resolve_in_utc(html, source_name);
            assert_eq!(
                resolved.calendar_date,
                Some(header),
                "importer policy: visible HTML date wins for {source_name}"
            );
            assert_eq!(resolved.chosen_source, AppleDateSource::HtmlHeader);
            assert_eq!(resolved.header_date, Some(header));
            assert_eq!(resolved.header_date_raw.as_deref(), Some(header_raw));
            assert_eq!(resolved.filename_date, Some(filename));
            assert!(
                has_warning(&resolved, AppleDateWarningKind::HeaderFilenameConflict),
                "conflict must be reviewable for {source_name}: {:?}",
                resolved.warnings
            );
            assert_eq!(resolved.precision, AppleDatePrecision::DateOnly);
            assert_eq!(resolved.conversion_timezone, "UTC");
        }
    }

    #[test]
    fn absent_header_falls_back_to_filename() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-08-20_filename-only.html");
        let resolved = resolve_in_utc(html, "Entries/2024-08-20_filename-only.html");
        assert_eq!(resolved.calendar_date, Some(ymd(2024, 8, 20)));
        assert_eq!(resolved.chosen_source, AppleDateSource::FilenameFallback);
        assert_eq!(resolved.header_date, None);
        assert_eq!(resolved.filename_date, Some(ymd(2024, 8, 20)));
        assert!(
            !has_warning(&resolved, AppleDateWarningKind::HeaderFilenameConflict),
            "absent header is fallback, not a conflict: {:?}",
            resolved.warnings
        );
        assert_eq!(
            resolved.entry_date_unix,
            Some(1_724_155_200),
            "date-only is local noon, never parse_iso_date midnight UTC"
        );
    }

    #[test]
    fn both_absent_or_invalid_sources_warn() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/undated_invalid-sources.html");
        let resolved = resolve_in_utc(html, "Entries/undated_invalid-sources.html");
        assert_eq!(resolved.calendar_date, None);
        assert_eq!(resolved.chosen_source, AppleDateSource::None);
        assert_eq!(resolved.entry_date_unix, None);
        assert_eq!(
            resolved.header_date_raw.as_deref(),
            None,
            "unparseable header text must not pass the parse-success gate"
        );
        assert_eq!(resolved.header_date, None);
        assert_eq!(resolved.filename_date, None);
        assert!(
            has_warning(&resolved, AppleDateWarningKind::SourcesUnreadable),
            "unreadable sources must be reviewable: {:?}",
            resolved.warnings
        );
    }

    #[test]
    fn unclosed_page_header_still_resolves_visible_calendar_date() {
        let html = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title></head>
<body>
<div class="pageHeader">Monday, March 1, 2024 leftover tokens after an unclosed header
<div class="title">Unclosed header</div>
<div class="bodyText"><p>Body stays after the date.</p></div>
</body></html>
"#;
        let resolved = resolve_in_utc(html, "Entries/2024-03-02_unclosed-page-header.html");
        assert_eq!(
            resolved.calendar_date,
            Some(ymd(2024, 3, 1)),
            "parse-success gate must keep the visible header date, not fall back to the filename"
        );
        assert_eq!(resolved.chosen_source, AppleDateSource::HtmlHeader);
        assert_eq!(resolved.header_date, Some(ymd(2024, 3, 1)));
        assert_eq!(resolved.filename_date, Some(ymd(2024, 3, 2)));
        assert!(
            parse_visible_calendar_date(
                resolved
                    .header_date_raw
                    .as_deref()
                    .expect("parseable header raw")
            )
            .is_some(),
            "extract_page_header_raw must only return a parseable calendar slice: {:?}",
            resolved.header_date_raw
        );
    }

    #[test]
    fn filename_date_allows_non_ascii_suffix() {
        let html = r#"<div class="pageHeader">Tuesday, July 27, 2022</div>"#;
        let resolved = resolve_in_utc(html, "Entries/2022-07-26_ngày.html");
        assert_eq!(
            resolved.filename_date,
            Some(ymd(2022, 7, 26)),
            "Unicode filename suffix must not drop the leading calendar token"
        );
        assert_eq!(resolved.header_date, Some(ymd(2022, 7, 27)));
        assert!(
            has_warning(&resolved, AppleDateWarningKind::HeaderFilenameConflict),
            "HTML vs filename discrepancy must still be reviewable: {:?}",
            resolved.warnings
        );
    }

    #[test]
    fn leap_day_is_a_valid_calendar_date() {
        let html = include_str!("../tests/fixtures/apple-journal/Entries/2024-02-29_leap-day.html");
        let resolved = resolve_in_utc(html, "Entries/2024-02-29_leap-day.html");
        assert_eq!(resolved.calendar_date, Some(ymd(2024, 2, 29)));
        assert_eq!(resolved.header_date, Some(ymd(2024, 2, 29)));
        assert_eq!(resolved.filename_date, Some(ymd(2024, 2, 29)));
        assert_eq!(resolved.entry_date_unix, Some(1_709_208_000));
        assert!(!has_warning(
            &resolved,
            AppleDateWarningKind::HeaderFilenameConflict
        ));
    }

    #[test]
    fn dst_transition_day_projects_unique_local_noon() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-10_dst-spring.html");
        let resolved = resolve_apple_entry_date(
            html,
            "Entries/2024-03-10_dst-spring.html",
            &UsEastern,
            "America/New_York",
            IMPORT_BOOKKEEPING_TS,
        );
        assert_eq!(resolved.calendar_date, Some(ymd(2024, 3, 10)));
        assert_eq!(
            resolved.entry_date_unix,
            Some(1_710_086_400),
            "2024-03-10 12:00 EDT is unique (spring gap is 02:00–03:00)"
        );
        assert_eq!(resolved.conversion_timezone, "America/New_York");
        assert!(!has_warning(
            &resolved,
            AppleDateWarningKind::NonexistentLocalTime
        ));
        assert!(!has_warning(
            &resolved,
            AppleDateWarningKind::AmbiguousLocalTime
        ));
    }

    #[test]
    fn nonexistent_local_time_is_rejected() {
        let html = include_str!("../tests/fixtures/apple-journal/Entries/2024-02-29_leap-day.html");
        let resolved = resolve_apple_entry_date(
            html,
            "Entries/2024-02-29_leap-day.html",
            &NoonDoesNotExist,
            "test/noon-gap",
            IMPORT_BOOKKEEPING_TS,
        );
        assert_eq!(
            resolved.calendar_date,
            Some(ymd(2024, 2, 29)),
            "calendar date is kept when the synthetic clock cannot be projected"
        );
        assert_eq!(resolved.entry_date_unix, None);
        assert!(
            has_warning(&resolved, AppleDateWarningKind::NonexistentLocalTime),
            "invalid local noon must not be guessed: {:?}",
            resolved.warnings
        );
    }

    /// Conversion zone whose local noon is ambiguous. Tests rejection, not a real TZ.
    #[derive(Clone, Copy, Debug)]
    struct NoonIsAmbiguous;

    impl TimeZone for NoonIsAmbiguous {
        type Offset = FixedOffset;

        fn from_offset(_offset: &Self::Offset) -> Self {
            NoonIsAmbiguous
        }

        fn offset_from_local_date(&self, _local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            MappedLocalTime::Single(FixedOffset::east_opt(0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            if local.hour() == 12 && local.minute() == 0 && local.second() == 0 {
                MappedLocalTime::Ambiguous(
                    FixedOffset::east_opt(3600).unwrap(),
                    FixedOffset::east_opt(0).unwrap(),
                )
            } else {
                MappedLocalTime::Single(FixedOffset::east_opt(0).unwrap())
            }
        }

        fn offset_from_utc_date(&self, _utc: &NaiveDate) -> FixedOffset {
            FixedOffset::east_opt(0).unwrap()
        }

        fn offset_from_utc_datetime(&self, _utc: &NaiveDateTime) -> FixedOffset {
            FixedOffset::east_opt(0).unwrap()
        }
    }

    #[test]
    fn ambiguous_local_noon_is_rejected() {
        let html = include_str!("../tests/fixtures/apple-journal/Entries/2024-02-29_leap-day.html");
        let resolved = resolve_apple_entry_date(
            html,
            "Entries/2024-02-29_leap-day.html",
            &NoonIsAmbiguous,
            "test/noon-ambiguous",
            IMPORT_BOOKKEEPING_TS,
        );
        assert_eq!(
            resolved.calendar_date,
            Some(ymd(2024, 2, 29)),
            "calendar date is kept when local noon is ambiguous"
        );
        assert_eq!(resolved.entry_date_unix, None);
        assert!(
            has_warning(&resolved, AppleDateWarningKind::AmbiguousLocalTime),
            "ambiguous local noon must not be guessed: {:?}",
            resolved.warnings
        );
    }

    #[test]
    fn imported_dates_set_user_edited_and_import_bookkeeping() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-08-20_filename-only.html");
        let resolved = resolve_in_utc(html, "Entries/2024-08-20_filename-only.html");
        assert!(
            resolved.entry_date_user_edited,
            "EXIF auto-suggestion must never override an imported Apple date"
        );
        assert_eq!(resolved.created_at, IMPORT_BOOKKEEPING_TS);
        assert_eq!(resolved.updated_at, IMPORT_BOOKKEEPING_TS);
        assert_eq!(resolved.precision, AppleDatePrecision::DateOnly);
    }

    fn parse_sidecar(json: &str) -> AppleParsedResourceMetadata {
        parse_apple_resource_metadata(json, None).expect("synthetic sidecar must parse")
    }

    #[test]
    fn apple_epoch_fractional_date_is_converted_and_raw_retained() {
        let json = include_str!("../tests/fixtures/apple-journal/Resources/photo-fractional.json");
        let meta = parse_sidecar(json);
        assert_eq!(
            meta.date_raw.as_deref(),
            Some("700000000.125"),
            "fractional source seconds must be retained, not rounded"
        );
        let apple_epoch = Utc
            .with_ymd_and_hms(2001, 1, 1, 0, 0, 0)
            .single()
            .expect("Apple reference date")
            .timestamp() as f64;
        let expected = 700_000_000.125 + apple_epoch;
        let unix = meta.date_unix.expect("converted date");
        assert!(
            (unix - expected).abs() < 1e-9,
            "Apple-epoch conversion must add 2001-01-01 UTC: got {unix}, expected {expected}"
        );
        assert_eq!(
            meta.place_name.as_deref(),
            Some("Synthetic Overlook"),
            "optional image placeName is retained"
        );
    }

    #[test]
    fn capture_disagreement_warns_without_guessing_offset() {
        let apple_seconds = 700_000_000.0;
        let apple_epoch = Utc
            .with_ymd_and_hms(2001, 1, 1, 0, 0, 0)
            .single()
            .expect("Apple reference date")
            .timestamp() as f64;
        let sidecar_unix = apple_seconds + apple_epoch;
        let seven_hours = 7.0 * 3600.0;
        let meta = parse_apple_resource_metadata(
            &format!(r#"{{"date":{apple_seconds}}}"#),
            Some(AppleEmbeddedCapture {
                unix_seconds: sidecar_unix + seven_hours,
            }),
        )
        .expect("sidecar date still parses");
        assert!(
            (meta.date_unix.expect("converted") - sidecar_unix).abs() < 1e-9,
            "must keep the sidecar conversion; do not apply a guessed timezone offset: {:?}",
            meta.date_unix
        );
        assert!(
            meta.warnings
                .iter()
                .any(|w| w.kind == AppleResourceWarningKind::CaptureDateDisagreement),
            "embedded capture that is only an offset away must warn, not be reconciled: {:?}",
            meta.warnings
        );
    }

    #[test]
    fn invalid_coordinates_are_rejected() {
        let meta = parse_sidecar(
            r#"{"visits":[{"placeName":"Invalid Peak","latitude":95.0,"longitude":20.0}]}"#,
        );
        assert_eq!(meta.visits.len(), 1);
        assert!(
            !meta.visits[0].coordinates_valid,
            "latitude 95 is outside WGS84"
        );
        assert_eq!(
            meta.native_location, None,
            "invalid coordinates must not become the native location"
        );
        assert!(
            meta.warnings
                .iter()
                .any(|w| w.kind == AppleResourceWarningKind::InvalidCoordinates),
            "invalid coordinates must be reviewable: {:?}",
            meta.warnings
        );
    }

    #[test]
    fn zero_visits_yield_no_native_location() {
        let json = include_str!("../tests/fixtures/apple-journal/Resources/map-empty.json");
        let meta = parse_sidecar(json);
        assert!(meta.visits.is_empty(), "empty visits array stays empty");
        assert_eq!(meta.native_location, None);
        assert!(
            !meta
                .warnings
                .iter()
                .any(|w| w.kind == AppleResourceWarningKind::InvalidCoordinates),
            "zero visits is not an invalid-coordinate warning: {:?}",
            meta.warnings
        );
    }

    #[test]
    fn multiple_visits_keep_order_and_first_valid_is_native() {
        let json = include_str!("../tests/fixtures/apple-journal/Resources/map-multi.json");
        let meta = parse_sidecar(json);
        assert_eq!(
            meta.visits
                .iter()
                .map(|v| v.place_name.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("Synthetic Park"),
                Some("Invalid Peak"),
                Some("Example Harbor")
            ],
            "all visits stay in source order"
        );
        assert!(meta.visits[0].coordinates_valid);
        assert!(!meta.visits[1].coordinates_valid);
        assert!(meta.visits[2].coordinates_valid);
        let native = meta
            .native_location
            .as_ref()
            .expect("first valid visit is native");
        assert_eq!(native.latitude, 10.5);
        assert_eq!(native.longitude, 20.25);
        assert_eq!(native.label.as_deref(), Some("Synthetic Park"));
        assert_eq!(native.address.as_deref(), Some("Example City"));
        assert_eq!(
            apple_visit_readable_line(&meta.visits[0]).as_deref(),
            Some("Synthetic Park, Example City")
        );
        assert_eq!(
            apple_visit_readable_line(&meta.visits[2]).as_deref(),
            Some("Example Harbor, Harbor Town")
        );
    }

    #[test]
    fn image_date_does_not_change_entry_date() {
        let html =
            include_str!("../tests/fixtures/apple-journal/Entries/2024-03-11_map-visits.html");
        let resolved = resolve_in_utc(html, "Entries/2024-03-11_map-visits.html");
        let image = parse_sidecar(include_str!(
            "../tests/fixtures/apple-journal/Resources/photo-fractional.json"
        ));
        assert_eq!(resolved.calendar_date, Some(ymd(2024, 3, 11)));
        assert_eq!(resolved.chosen_source, AppleDateSource::HtmlHeader);
        assert_eq!(
            resolved.entry_date_unix,
            Some(1_710_158_400),
            "entry clock stays local noon for the HTML date"
        );
        let image_unix = image.date_unix.expect("image sidecar date");
        assert!(
            (image_unix - 1_710_158_400.0).abs() > 86_400.0,
            "fixture image date must differ from the journal date so this is a real isolation check"
        );
        assert_eq!(
            resolved.calendar_date,
            resolve_apple_entry_date(
                html,
                "Entries/2024-03-11_map-visits.html",
                &Utc,
                "UTC",
                IMPORT_BOOKKEEPING_TS,
            )
            .calendar_date,
            "resource dates are never an input to resolve_apple_entry_date"
        );
    }

    fn fp_parts<'a>(
        path: &'a Path,
        title: Option<&'a str>,
        body: &'a str,
        html: &'a str,
        sidecars: &'a [AppleFingerprintSidecar<'a>],
        resources: &'a [AppleFingerprintResource<'a>],
    ) -> AppleSourceFingerprintParts<'a> {
        AppleSourceFingerprintParts {
            relative_path: path,
            title,
            body_text: body,
            raw_html: html,
            sidecars,
            resources,
        }
    }

    #[test]
    fn source_fingerprint_is_stable_for_identical_canonical_inputs() {
        let path = Path::new("Entries/2024-03-01.html");
        let sidecars = [AppleFingerprintSidecar {
            relative_name: "photo.json",
            json: r#"{"date":1,"placeName":"Park"}"#,
        }];
        let resources = [AppleFingerprintResource {
            relative_name: "photo.png",
            sha256: "abc123",
        }];
        let a = apple_source_fingerprint(&fp_parts(
            path,
            Some("Day"),
            "hello",
            "<html>day</html>",
            &sidecars,
            &resources,
        ));
        let b = apple_source_fingerprint(&fp_parts(
            path,
            Some("Day"),
            "hello",
            "<html>day</html>",
            &sidecars,
            &resources,
        ));
        assert_eq!(a, b);
        assert_eq!(a.len(), 64, "fingerprint is sha256 hex");
        assert!(
            a.chars().all(|c| c.is_ascii_hexdigit()),
            "fingerprint must be hex: {a}"
        );
    }

    #[test]
    fn source_fingerprint_changes_when_resource_hash_changes() {
        let path = Path::new("Entries/2024-03-01.html");
        let photo_a = [AppleFingerprintResource {
            relative_name: "photo.png",
            sha256: "aaa",
        }];
        let photo_b = [AppleFingerprintResource {
            relative_name: "photo.png",
            sha256: "bbb",
        }];
        let a = apple_source_fingerprint(&fp_parts(
            path,
            None,
            "",
            "<html>photo</html>",
            &[],
            &photo_a,
        ));
        let b = apple_source_fingerprint(&fp_parts(
            path,
            None,
            "",
            "<html>photo</html>",
            &[],
            &photo_b,
        ));
        assert_ne!(
            a, b,
            "empty-text photo entries with different hashes must stay distinct"
        );
    }

    #[test]
    fn source_identity_normalizes_path_separators_and_unicode() {
        let nfd = "Entries/cafe\u{0301}.html";
        let nfc = "Entries/café.html";
        assert_eq!(
            apple_source_identity(Path::new(nfd)),
            apple_source_identity(Path::new(nfc))
        );
        assert_eq!(
            apple_source_identity(Path::new("Entries\\2024-03-01.html")),
            apple_source_identity(Path::new("Entries/2024-03-01.html"))
        );
        assert_eq!(
            apple_source_identity(Path::new("Entries/Day.html")),
            apple_source_identity(Path::new("entries/day.html")),
            "export folder rename / case fold must not change identity"
        );
    }

    #[test]
    fn distinct_entry_paths_keep_distinct_fingerprints() {
        let resources = [AppleFingerprintResource {
            relative_name: "photo.png",
            sha256: "same-hash",
        }];
        let a = apple_source_fingerprint(&fp_parts(
            Path::new("Entries/2024-03-01-a.html"),
            None,
            "",
            "<html/>",
            &[],
            &resources,
        ));
        let b = apple_source_fingerprint(&fp_parts(
            Path::new("Entries/2024-03-01-b.html"),
            None,
            "",
            "<html/>",
            &[],
            &resources,
        ));
        assert_ne!(a, b, "same-day photo-only files must not collapse");
    }

    #[test]
    fn source_fingerprint_includes_parsed_text_format_and_sidecar_metadata() {
        let path = Path::new("Entries/2024-03-01.html");
        let resources = [AppleFingerprintResource {
            relative_name: "photo.png",
            sha256: "abc",
        }];
        let sidecar = [AppleFingerprintSidecar {
            relative_name: "photo.json",
            json: r#"{"placeName":"Park"}"#,
        }];
        let base = apple_source_fingerprint(&fp_parts(
            path,
            Some("T"),
            "body",
            "<p>body</p>",
            &sidecar,
            &resources,
        ));
        assert_ne!(
            base,
            apple_source_fingerprint(&fp_parts(
                path,
                Some("T"),
                "changed body",
                "<p>body</p>",
                &sidecar,
                &resources,
            )),
            "parsed text is part of the fingerprint"
        );
        assert_ne!(
            base,
            apple_source_fingerprint(&fp_parts(
                path,
                Some("T"),
                "body",
                "<p>body</p><b></b>",
                &sidecar,
                &resources,
            )),
            "HTML format is part of the fingerprint"
        );
        assert_ne!(
            base,
            apple_source_fingerprint(&fp_parts(
                path,
                Some("T"),
                "body",
                "<p>body</p>",
                &[AppleFingerprintSidecar {
                    relative_name: "photo.json",
                    json: r#"{"placeName":"Lake"}"#,
                }],
                &resources,
            )),
            "source metadata is part of the fingerprint"
        );
    }

    #[test]
    fn fingerprint_unreadable_sidecar_is_hard_preflight_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let entry = entry(&scan, "2024-03-01.html");
        let sidecar = entry.media_refs[0]
            .sidecar_path
            .as_ref()
            .expect("fixture binds a sidecar")
            .clone();
        fs::remove_file(&sidecar).unwrap();

        let err = fingerprint_apple_journal_entry(entry, &scan.resources, &scan.root)
            .expect_err("a now-unreadable sidecar must be a hard preflight error");
        let lower = err.to_lowercase();
        assert!(
            lower.contains("sidecar") || lower.contains("unreadable") || lower.contains("read"),
            "error must name the sidecar failure: {err}"
        );
    }

    #[test]
    fn fingerprint_rejects_post_scan_sidecar_leaf_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path());
        let scan = scan_apple_journal_folder(tmp.path()).expect("scan");
        let entry = entry(&scan, "2024-03-01.html");
        let sidecar = entry.media_refs[0]
            .sidecar_path
            .as_ref()
            .expect("fixture binds a sidecar")
            .clone();
        let outside = tmp.path().join("outside-secret.json");
        fs::write(&outside, r#"{"leaked":true}"#).unwrap();
        fs::remove_file(&sidecar).unwrap();
        std::os::unix::fs::symlink(&outside, &sidecar).unwrap();

        let err = fingerprint_apple_journal_entry(entry, &scan.resources, &scan.root)
            .expect_err("post-scan sidecar symlink must fail closed");
        let lower = err.to_lowercase();
        assert!(
            lower.contains("symlink") || lower.contains("escape") || lower.contains("root"),
            "error must name the symlink/escape: {err}"
        );
    }

    /// Local-only acceptance against a real extracted Apple Journal folder.
    ///
    /// Set `APPLE_JOURNAL_EXPORT_DIR` to the export root (`index.html` +
    /// `Entries/` + `Resources/`). Default `cargo test` ignores this. Run:
    /// `APPLE_JOURNAL_EXPORT_DIR=/path cargo test --manifest-path src-tauri/Cargo.toml --lib import_apple_journal::tests::local_export_acceptance_against_supplied_folder -- --ignored --nocapture`
    ///
    /// Assertions are aggregates only. Never print journal text, titles,
    /// original filenames, coordinates, or media paths.
    #[test]
    #[ignore = "set APPLE_JOURNAL_EXPORT_DIR to a local extracted Apple Journal folder"]
    fn local_export_acceptance_against_supplied_folder() {
        let export_dir = std::env::var("APPLE_JOURNAL_EXPORT_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .expect(
                "APPLE_JOURNAL_EXPORT_DIR must point at a local extracted Apple Journal folder",
            );
        assert!(
            export_dir.is_dir(),
            "APPLE_JOURNAL_EXPORT_DIR is not a directory"
        );

        const EXPECTED_ENTRIES: usize = 45;
        const EXPECTED_MEDIA_REFS: usize = 267;
        const EXPECTED_JSON: usize = 267;
        const EXPECTED_MAP_VISITS: usize = 40;
        const EXPECTED_DATE_CONFLICTS: usize = 3;
        const EXPECTED_LIVE_PHOTO_STILLS: usize = 2;
        const AUDIT_LARGEST_BYTES: u64 = 182_144_379;
        const AUDIT_EXPORT_BYTES: u64 = 1_079_567_911;

        let rss_before = peak_rss_bytes();
        let scan = scan_apple_journal_folder(&export_dir).expect("scan supplied export");
        let disk = classify_export_disk(&export_dir).expect("export disk walk");

        assert_eq!(
            scan.entries.len(),
            EXPECTED_ENTRIES,
            "entry HTML documents (index excluded)"
        );
        let media_refs: usize = scan
            .entries
            .iter()
            .map(|entry| entry.media_refs.len())
            .sum();
        assert_eq!(media_refs, EXPECTED_MEDIA_REFS, "HTML media references");
        assert_eq!(
            disk.json_files, EXPECTED_JSON,
            "resource JSON files on disk"
        );

        let mut visit_count = 0usize;
        for sidecar in &disk.json_paths {
            let text = fs::read_to_string(sidecar).expect("read sidecar");
            let meta = parse_apple_resource_metadata(&text, None).expect("parse sidecar");
            visit_count += meta.visits.len();
        }
        assert_eq!(
            visit_count, EXPECTED_MAP_VISITS,
            "map visits across sidecars"
        );

        let mut date_conflicts = 0usize;
        let mut live_photo_cards = 0usize;
        let mut vietnamese_entries = 0usize;
        let mut converted_space_entries = 0usize;
        let mut empty_paragraphs = 0usize;
        let mut nonempty_titles = 0usize;
        for entry in &scan.entries {
            let source_name = entry.relative_path.to_string_lossy();
            let resolved = resolve_apple_entry_date_local(&entry.raw_html, &source_name, 0);
            if resolved
                .warnings
                .iter()
                .any(|w| w.kind == AppleDateWarningKind::HeaderFilenameConflict)
            {
                date_conflicts += 1;
            }
            live_photo_cards += count_ci(&entry.raw_html, "assetType_livephoto");
            if contains_vietnamese(&entry.body_text) || contains_vietnamese(&entry.raw_html) {
                vietnamese_entries += 1;
            }
            if entry.raw_html.contains("Apple-converted-space")
                || entry.body_text.contains('\u{00a0}')
            {
                converted_space_entries += 1;
            }
            empty_paragraphs += count_empty_paragraphs(&entry.raw_html);
            if entry.title.as_ref().is_some_and(|title| !title.is_empty()) {
                nonempty_titles += 1;
            }
        }
        assert_eq!(
            date_conflicts, EXPECTED_DATE_CONFLICTS,
            "HTML vs filename date discrepancies"
        );
        assert_eq!(
            live_photo_cards, EXPECTED_LIVE_PHOTO_STILLS,
            "Live Photo cards (still-only)"
        );
        assert!(
            vietnamese_entries > 0,
            "at least one entry must contain Vietnamese text"
        );
        assert!(
            converted_space_entries > 0 || empty_paragraphs > 0,
            "source uses Apple-converted spaces and/or empty paragraphs"
        );

        let missing_refs = scan
            .entries
            .iter()
            .flat_map(|entry| entry.media_refs.iter())
            .filter(|media| media.media_path.is_none())
            .count();
        let hashed_ok = scan
            .resources
            .iter()
            .filter(|resource| {
                stream_sha256(&resource.media_path)
                    .ok()
                    .is_some_and(|(len, digest)| {
                        len == resource.byte_len && digest == resource.sha256
                    })
            })
            .count();
        assert_eq!(
            hashed_ok,
            scan.resources.len(),
            "every on-disk inventoried resource must rehash to its scan digest"
        );

        let largest = scan
            .resources
            .iter()
            .max_by_key(|resource| resource.byte_len)
            .map(|resource| resource.byte_len)
            .unwrap_or(0);
        let has_audit_largest = scan
            .resources
            .iter()
            .any(|resource| resource.byte_len == AUDIT_LARGEST_BYTES);

        let accounted = disk.index_html
            + disk.entry_html
            + disk.json_files
            + disk.media_files
            + disk.filesystem_metadata
            + disk.other_non_system;
        assert_eq!(
            accounted, disk.total_files,
            "every non-directory file must be classified"
        );
        assert_eq!(
            disk.other_non_system, 0,
            "unexpected non-system files must be accounted, not ignored"
        );

        let state = crate::AppState::new({
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            crate::db::schema::migrate(&conn).unwrap();
            conn
        });
        let key_state = crate::EncryptionKeyState::new();
        key_state
            .set_key(
                crate::utils::encryption::derive_encryption_key(
                    "pw",
                    &[7u8; crate::utils::encryption::SALT_SIZE],
                )
                .unwrap(),
            )
            .unwrap();
        let media_root = tempfile::tempdir().unwrap();
        {
            let conn = state.lock().unwrap();
            crate::db::set_setting(
                &conn,
                "media_root_path",
                media_root.path().to_str().unwrap(),
            )
            .unwrap();
        }
        let journal_id = {
            let conn = state.lock().unwrap();
            crate::db::list_journals(&conn, None).unwrap()[0].id.clone()
        };

        let first = crate::commands::import::import_data_inner(
            None,
            &state,
            &key_state,
            export_dir.to_string_lossy().to_string(),
            crate::commands::import::ImportFormat::AppleJournalFolder,
            crate::commands::import::ImportMode::MergeNewer,
            Some(journal_id.clone()),
        )
        .expect(
            "import the original supplied folder (unreferenced binaries must not block persist)",
        );
        let apple = first.apple.as_ref().expect("apple report");
        assert_eq!(
            apple.entries_imported, EXPECTED_ENTRIES as u64,
            "first import writes every parsed entry"
        );
        assert_eq!(apple.resources_referenced, EXPECTED_MEDIA_REFS as u64);
        assert_eq!(
            apple.resources_missing, missing_refs as u64,
            "missing binaries must be counted, not dropped"
        );
        assert_eq!(
            apple.resources_unreferenced,
            scan.unreferenced_resources.len() as u64,
            "unreferenced binaries are counted and retained, not sanitized away"
        );
        if !scan.unreferenced_resources.is_empty() {
            assert!(
                first
                    .warnings
                    .iter()
                    .any(|w| w.kind == "unreferenced_resource"),
                "persist of the original folder must warn about unreferenced binaries: {:?}",
                first.warnings.iter().map(|w| &w.kind).collect::<Vec<_>>()
            );
        }
        let live_warnings = first
            .warnings
            .iter()
            .filter(|w| w.feature.as_deref() == Some("asset-type:livephoto"))
            .count();
        let live_cards_in_unknown = scan
            .unknown_cards
            .iter()
            .filter(|card| card.asset_type == "livephoto" || card.asset_type == "live_photo")
            .count();
        assert!(
            live_photo_cards == EXPECTED_LIVE_PHOTO_STILLS
                || live_cards_in_unknown >= EXPECTED_LIVE_PHOTO_STILLS
                || live_warnings >= EXPECTED_LIVE_PHOTO_STILLS,
            "two Live Photo still-only cards must be accounted (html={live_photo_cards} scan_cards={live_cards_in_unknown} import_warnings={live_warnings})"
        );

        {
            let conn = state.lock().unwrap();
            let rows = crate::db::list_all_entries(&conn).unwrap();
            assert_eq!(rows.len(), EXPECTED_ENTRIES);
            let mut compared = 0usize;
            let mut locations = 0usize;
            for entry in &scan.entries {
                let identity = apple_source_identity(&entry.relative_path);
                let hits =
                    crate::db::find_apple_import_by_source_identity(&conn, &journal_id, &identity)
                        .unwrap();
                assert_eq!(
                    hits.len(),
                    1,
                    "each source identity maps to one imported row"
                );
                let row = crate::db::get_entry(&conn, &hits[0].entry_id)
                    .unwrap()
                    .expect("imported row");
                assert_eq!(row.title, entry.title, "title must match parsed .title");
                let imported_text = row.content_text.as_deref().unwrap_or("");
                for line in entry.body_text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    assert!(
                        imported_text.contains(trimmed),
                        "imported body is missing a source text line (index {compared})"
                    );
                }
                if row.latitude.is_some() && row.longitude.is_some() {
                    locations += 1;
                } else {
                    let mut visits = Vec::new();
                    for media in &entry.media_refs {
                        let Some(sidecar) = media.sidecar_path.as_ref() else {
                            continue;
                        };
                        let Ok(text) = fs::read_to_string(sidecar) else {
                            continue;
                        };
                        if let Ok(meta) = parse_apple_resource_metadata(&text, None) {
                            visits.extend(meta.visits);
                        }
                    }
                    assert!(
                        first_valid_apple_native_location(&visits).is_none(),
                        "imported row is missing native_location that the source sidecar still has"
                    );
                }
                let media = crate::db::get_media_for_entry(&conn, &row.id).unwrap();
                for item in &media {
                    let path = Path::new(&item.storage_path);
                    let (len, digest) = stream_sha256(path).expect("hash imported original");
                    let source = scan
                        .resources
                        .iter()
                        .find(|resource| resource.byte_len == len && resource.sha256 == digest);
                    assert!(
                        source.is_some(),
                        "imported media bytes must match an inventoried source hash"
                    );
                }
                compared += 1;
            }
            assert_eq!(compared, EXPECTED_ENTRIES);
            let mut expected_pins = 0usize;
            for entry in &scan.entries {
                let mut visits = Vec::new();
                for media in &entry.media_refs {
                    let Some(sidecar) = media.sidecar_path.as_ref() else {
                        continue;
                    };
                    let Ok(text) = fs::read_to_string(sidecar) else {
                        continue;
                    };
                    if let Ok(meta) = parse_apple_resource_metadata(&text, None) {
                        visits.extend(meta.visits);
                    }
                }
                if first_valid_apple_native_location(&visits).is_some() {
                    expected_pins += 1;
                }
            }
            assert_eq!(
                locations, expected_pins,
                "imported native_location pins must match source sidecars, not be discarded"
            );
        }

        let repeat = crate::commands::import::import_data_inner(
            None,
            &state,
            &key_state,
            export_dir.to_string_lossy().to_string(),
            crate::commands::import::ImportFormat::AppleJournalFolder,
            crate::commands::import::ImportMode::MergeNewer,
            Some(journal_id),
        )
        .expect("exact-repeat import");
        assert_eq!(repeat.imported, 0, "unchanged source must not create rows");
        let repeat_apple = repeat.apple.as_ref().expect("repeat apple report");
        assert_eq!(
            repeat_apple.entries_skipped_exact, EXPECTED_ENTRIES as u64,
            "exact-repeat import skips every unchanged source"
        );

        let rss_after = peak_rss_bytes();
        let heic_decode = macos_heic_decode_sample(&scan);
        let has_mov = scan.resources.iter().any(|resource| {
            resource
                .media_path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("mov") || ext.eq_ignore_ascii_case("mp4")
                })
        });

        eprintln!(
            "apple-journal-acceptance entries={} refs={} json={} visits={} date_conflicts={} live_photo_still_only={} live_photo_import_warnings={} hashed_resources={} missing_refs={} unreferenced={} disk_bytes={} largest_bytes={} audit_largest_present={} audit_export_bytes={} rss_before={:?} rss_after={:?} heic_sips_ok={:?} mov_present={} nonempty_titles={} vietnamese_entries={} empty_paragraphs={} converted_space_entries={}",
            scan.entries.len(),
            media_refs,
            disk.json_files,
            visit_count,
            date_conflicts,
            live_photo_cards,
            live_warnings,
            hashed_ok,
            missing_refs,
            scan.unreferenced_resources.len(),
            disk.total_bytes,
            largest,
            has_audit_largest,
            AUDIT_EXPORT_BYTES,
            rss_before,
            rss_after,
            heic_decode,
            has_mov,
            nonempty_titles,
            vietnamese_entries,
            empty_paragraphs,
            converted_space_entries
        );
        if !has_audit_largest {
            eprintln!(
                "apple-journal-acceptance: {AUDIT_LARGEST_BYTES}-byte resource is absent from this folder; large-file streaming was not exercised"
            );
        }
        if disk.total_bytes < AUDIT_EXPORT_BYTES {
            eprintln!(
                "apple-journal-acceptance: folder is {} bytes, not the audited {AUDIT_EXPORT_BYTES}; peak RSS is for this input only",
                disk.total_bytes
            );
        }
        if !has_mov {
            eprintln!(
                "apple-journal-acceptance: no MOV/MP4 present; video playback was not verified"
            );
        }
        eprintln!("apple-journal-acceptance: WKWebView HEIC/MOV visual playback was not exercised");
        if !scan.unreferenced_resources.is_empty() {
            eprintln!(
                "apple-journal-acceptance: original folder has {} unreferenced non-system resource(s); they were counted and retained, not assigned to an entry",
                scan.unreferenced_resources.len()
            );
        }
    }

    #[derive(Debug)]
    struct ExportDiskAccount {
        index_html: usize,
        entry_html: usize,
        json_files: usize,
        media_files: usize,
        filesystem_metadata: usize,
        other_non_system: usize,
        total_files: usize,
        total_bytes: u64,
        json_paths: Vec<PathBuf>,
    }

    fn classify_export_disk(root: &Path) -> Result<ExportDiskAccount, String> {
        let mut account = ExportDiskAccount {
            index_html: 0,
            entry_html: 0,
            json_files: 0,
            media_files: 0,
            filesystem_metadata: 0,
            other_non_system: 0,
            total_files: 0,
            total_bytes: 0,
            json_paths: Vec::new(),
        };
        walk_export_disk(root, root, &mut account)?;
        Ok(account)
    }

    fn walk_export_disk(
        dir: &Path,
        root: &Path,
        account: &mut ExportDiskAccount,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read entry in {}: {e}", dir.display()))?;
            let path = entry.path();
            if path.is_dir() {
                walk_export_disk(&path, root, account)?;
                continue;
            }
            if !path.is_file() {
                continue;
            }
            account.total_files += 1;
            account.total_bytes += fs::metadata(&path)
                .map_err(|e| format!("stat {}: {e}", path.display()))?
                .len();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if FILESYSTEM_METADATA_NAMES
                .iter()
                .any(|listed| name.eq_ignore_ascii_case(listed))
            {
                account.filesystem_metadata += 1;
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if rel == Path::new("index.html") {
                account.index_html += 1;
            } else if rel.starts_with("Entries") && ext == "html" {
                account.entry_html += 1;
            } else if rel.starts_with("Resources") && ext == "json" {
                account.json_files += 1;
                account.json_paths.push(path);
            } else if rel.starts_with("Resources") {
                account.media_files += 1;
            } else {
                account.other_non_system += 1;
            }
        }
        Ok(())
    }

    fn count_ci(haystack: &str, needle: &str) -> usize {
        haystack
            .to_ascii_lowercase()
            .matches(&needle.to_ascii_lowercase())
            .count()
    }

    fn contains_vietnamese(text: &str) -> bool {
        text.chars().any(|ch| {
            matches!(
                ch,
                '\u{0110}'
                    | '\u{0111}'
                    | '\u{0102}'
                    | '\u{0103}'
                    | '\u{01A0}'
                    | '\u{01A1}'
                    | '\u{01AF}'
                    | '\u{01B0}'
            ) || ('\u{1EA0}'..='\u{1EF9}').contains(&ch)
        })
    }

    fn count_empty_paragraphs(html: &str) -> usize {
        let mut count = 0usize;
        let lower = html;
        let mut rest = lower;
        while let Some(start) = rest.find("<p") {
            let after = &rest[start..];
            let Some(end) = after.find("</p>") else {
                break;
            };
            let inner = &after[..end + 4];
            let stripped: String = inner
                .replace("&nbsp;", " ")
                .replace('\u{00a0}', " ")
                .chars()
                .collect();
            let mut visible = String::new();
            let mut in_tag = false;
            for ch in stripped.chars() {
                match ch {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    _ if !in_tag => visible.push(ch),
                    _ => {}
                }
            }
            if visible.trim().is_empty() {
                count += 1;
            }
            rest = &after[end + 4..];
        }
        count
    }

    fn peak_rss_bytes() -> Option<u64> {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        if rc != 0 {
            return None;
        }
        let usage = unsafe { usage.assume_init() };
        #[cfg(target_os = "macos")]
        {
            Some(usage.ru_maxrss as u64)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Some((usage.ru_maxrss as u64).saturating_mul(1024))
        }
    }

    fn macos_heic_decode_sample(scan: &AppleJournalFolder) -> Option<bool> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = scan;
            return None;
        }
        #[cfg(target_os = "macos")]
        {
            let heic = scan.resources.iter().find(|resource| {
                resource
                    .media_path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif")
                    })
            })?;
            let status = std::process::Command::new("sips")
                .args(["-g", "format"])
                .arg(&heic.media_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .ok()?;
            Some(status.success())
        }
    }

    #[test]
    fn classify_export_disk_fails_closed_on_unreadable_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("Entries")).unwrap();
        let locked = tmp.path().join("Resources/locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(tmp.path().join("index.html"), "<html></html>").unwrap();
        fs::write(locked.join("hidden.bin"), b"cannot-count-me").unwrap();

        let mut perms = fs::metadata(&locked).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o000);
        fs::set_permissions(&locked, perms).unwrap();

        let result = classify_export_disk(tmp.path());

        let mut restore = fs::metadata(&locked).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&locked, restore).unwrap();

        assert!(
            result.is_err(),
            "an unreadable subtree must fail the disk audit, not silently omit files: {result:?}"
        );
    }
}
