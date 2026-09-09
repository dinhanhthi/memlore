//! Stable, content-addressed chunking for the chunk-only embedding cutover.
//!
//! [`chunk_indexable_text`] takes the canonical per-entry text produced by
//! [`crate::ai::indexer::build_indexable_text`] and splits it into
//! semantically-bounded [`Chunk`]s (paragraph / heading / list boundaries —
//! **never** fixed character windows) so retrieval can point at the specific
//! passage that matched instead of the whole entry, and so editing one
//! paragraph only invalidates that paragraph's embedding.
//!
//! ## Offsets and hashing — how they fit together
//!
//! - `char_start`/`char_end` are **byte offsets** (Rust string slicing is
//!   byte-based; journal text is UTF-8 and these offsets always land on
//!   char boundaries) into the *core* span of the chunk — the paragraph's
//!   own boundary-delimited text, trimmed of surrounding whitespace. This
//!   means `&text[char_start..char_end]` always reconstructs exactly the
//!   chunk's own content, with no cross-chunk contamination.
//! - `text` is exactly that core content — nothing borrowed from a
//!   neighboring chunk. An earlier version prefixed `text` with a small
//!   overlap borrowed from the previous chunk's tail (sliding-window extra
//!   context for the embedder) while computing `content_hash` from the core
//!   only, as a token-saving tradeoff. That broke the hash⇔vector identity:
//!   if the previous paragraph's trailing chars changed, this chunk's real
//!   embed input changed while its hash stayed stable, so the diff planner
//!   could reuse a vector computed from stale context. Chunk boundaries are
//!   semantic (one TipTap block per chunk — see [`split_into_blocks`]), not
//!   fixed character windows, so that borrowed prefix bought little context
//!   for what it cost. `text` now IS the core, so `content_hash` (computed
//!   from `text` via [`hash_normalized`]) covers exactly the bytes sent to
//!   the embedder, by construction.
//! - That fix only holds for chunks embedded AFTER it shipped. Because
//!   `content_hash` was always computed from the core only (before AND
//!   after this fix), an already-stored row's hash reproduces exactly under
//!   the new code even though its vector was actually embedded from
//!   `overlap + core`, not `core` alone — a silent, permanent false cache
//!   hit with no natural trigger to re-embed it. [`CHUNK_HASH_VERSION`]
//!   closes that: it's mixed into every hash below, so bumping it once
//!   invalidates every row embedded under a since-changed scheme, and the
//!   existing diff planner (`ai::indexer::plan_chunk_diff`) re-embeds them
//!   with no migration code needed.
//!
//! "Normalized" (for hashing) means: trim leading/trailing whitespace, and
//! collapse every run of internal whitespace (spaces, tabs, newlines) to a
//! single space. Two chunks that differ only in whitespace hash the same.
//!
//! ## Bounding worst-case size
//!
//! Two limits keep a single entry's embedding cost bounded no matter how it
//! is written:
//!
//! - [`AI_CHUNK_MAX_CHARS`] bounds any *individual* chunk's core text — an
//!   oversized block (e.g. one giant paragraph with no line breaks) is
//!   split into multiple sub-blocks before chunk assembly, so no chunk sent
//!   to an embedding provider can blow a model's context window.
//! - [`AI_ENTRY_MAX_CHUNKS`] bounds the *count* of chunks per entry, same as
//!   before. When even a size-aware merge can't bring the block count down
//!   to the cap (pathologically many oversized blocks), the tail is
//!   dropped rather than exceeded — coverage is truncated for that entry,
//!   never the per-chunk size limit. Worst case, an entry's indexed text is
//!   bounded at `AI_ENTRY_MAX_CHUNKS * AI_CHUNK_MAX_CHARS` characters.

use sha2::{Digest, Sha256};

/// Hard cap on chunks per entry. Beyond this, adjacent blocks are merged
/// when the merge stays within [`AI_CHUNK_MAX_CHARS`]; if legal merges
/// still can't bring the count down to the cap, the tail is dropped (see
/// [`cap_blocks`]) so every entry is still bounded, just possibly at
/// coarser granularity or (rarely) partial coverage.
pub const AI_ENTRY_MAX_CHUNKS: usize = 64;

/// Hard cap on a single chunk's core text, in Unicode scalar values
/// (`chars()`, not bytes — UTF-8 multi-byte text like Vietnamese must not
/// be split mid-character). ~500 tokens, safe for 512-token embedding
/// models. Blocks longer than this are split before chunk assembly; see
/// [`split_long_block`].
pub const AI_CHUNK_MAX_CHARS: usize = 2000;

/// Max length (in chars) of `Chunk::preview` before truncation.
const PREVIEW_MAX_CHARS: usize = 160;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub chunk_index: usize,
    pub char_start: usize,
    pub char_end: usize,
    pub text: String,
    pub preview: String,
    pub content_hash: String,
}

/// Split `text` (the canonical `title + "\n\n" + content_text` produced by
/// [`crate::ai::indexer::build_indexable_text`]) into stable chunks.
///
/// - Empty / whitespace-only input → zero chunks (nothing to embed).
/// - Any other input with no line/heading/list boundaries → exactly one
///   chunk (the fallback that replaces the old entry-level vector), unless
///   it's long enough to be split by the [`AI_CHUNK_MAX_CHARS`] cap below.
/// - No chunk's core text ever exceeds [`AI_CHUNK_MAX_CHARS`] — oversized
///   blocks are split before chunk assembly.
/// - Output never exceeds [`AI_ENTRY_MAX_CHUNKS`] — beyond the cap, adjacent
///   blocks are merged in order until the count fits, without producing a
///   merged chunk over [`AI_CHUNK_MAX_CHARS`] (see [`cap_blocks`]).
pub fn chunk_indexable_text(text: &str) -> Vec<Chunk> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let mut blocks = split_into_blocks(text);
    blocks = split_oversized_blocks(text, blocks, AI_CHUNK_MAX_CHARS);
    blocks = cap_blocks(text, blocks, AI_ENTRY_MAX_CHUNKS, AI_CHUNK_MAX_CHARS);

    let mut chunks = Vec::with_capacity(blocks.len());
    for (chunk_index, &(start, end)) in blocks.iter().enumerate() {
        let core = &text[start..end];

        chunks.push(Chunk {
            chunk_index,
            char_start: start,
            char_end: end,
            text: core.to_string(),
            preview: truncate_preview(core),
            content_hash: hash_normalized(core),
        });
    }

    chunks
}

/// Split `text` into boundary-delimited blocks, returned as `(start, end)`
/// byte-offset ranges (each trimmed of surrounding whitespace).
///
/// This mirrors `extractPlainText`'s output shape (`src/lib/yjs.ts`), which
/// emits exactly one line per TipTap block (paragraph, heading, list item,
/// ...) — so "one line = one block" is the real granularity, and every
/// non-blank line is its own block boundary. The one exception is a
/// compact list: consecutive list items (no blank line between them) stay
/// together as a single cohesive block, separate from the text around it,
/// so a bullet list doesn't fragment into one chunk per bullet. Headings
/// and the line right after a heading fall out of this automatically —
/// they're never list items, so they always start a new block.
///
/// Boundaries:
/// - every non-blank line starts a new block, unless it and the previous
///   line are both list items,
/// - blank lines are separators (they close the current block and produce
///   no block of their own).
fn split_into_blocks(text: &str) -> Vec<(usize, usize)> {
    let mut blocks = Vec::new();
    let mut in_block = false;
    let mut block_start = 0usize;
    let mut block_end = 0usize;
    let mut prev_list = false;

    for (start, end) in line_offsets(text) {
        let line = &text[start..end];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            if in_block {
                blocks.push((block_start, block_end));
                in_block = false;
            }
            prev_list = false;
            continue;
        }

        let is_list = is_list_item(trimmed);

        if in_block {
            let breaks_here = !(is_list && prev_list);
            if breaks_here {
                blocks.push((block_start, block_end));
                block_start = start;
                block_end = end;
            } else {
                block_end = end;
            }
        } else {
            block_start = start;
            block_end = end;
            in_block = true;
        }

        prev_list = is_list;
    }

    if in_block {
        blocks.push((block_start, block_end));
    }

    blocks
        .into_iter()
        .map(|(s, e)| trim_range(text, s, e))
        .filter(|(s, e)| s < e)
        .collect()
}

/// Byte-offset `(start, end)` for each line in `text`, splitting on `\n`.
/// `end` excludes the newline itself.
fn line_offsets(text: &str) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut start = 0usize;
    for (i, c) in text.char_indices() {
        if c == '\n' {
            result.push((start, i));
            start = i + 1;
        }
    }
    result.push((start, text.len()));
    result
}

/// Trim whitespace off both ends of `text[start..end]`, returning the
/// adjusted byte-offset range.
fn trim_range(text: &str, start: usize, end: usize) -> (usize, usize) {
    let slice = &text[start..end];
    let after_leading = slice.trim_start();
    let leading = slice.len() - after_leading.len();
    let trimmed = after_leading.trim_end();
    (start + leading, start + leading + trimmed.len())
}

fn is_list_item(trimmed: &str) -> bool {
    if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
        return true;
    }
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        return trimmed[digits.len()..].starts_with(". ");
    }
    false
}

/// Split any block whose core text exceeds `max_chars` (Unicode scalar
/// values) into multiple sub-blocks, each `<= max_chars`. Applied right
/// after [`split_into_blocks`], before capping — this is what bounds a
/// single pathologically long paragraph (no line breaks at all) to a safe
/// per-chunk size before it ever reaches an embedding provider.
fn split_oversized_blocks(
    text: &str,
    blocks: Vec<(usize, usize)>,
    max_chars: usize,
) -> Vec<(usize, usize)> {
    let mut result = Vec::with_capacity(blocks.len());
    for (start, end) in blocks {
        result.extend(split_long_block(text, start, end, max_chars));
    }
    result
}

/// Split a single `(start, end)` block into sub-blocks no longer than
/// `max_chars` (Unicode scalar values, not bytes — UTF-8 multi-byte
/// characters, e.g. Vietnamese diacritics, must never be split
/// mid-character). Prefers to break at a whitespace boundary in the back
/// half of the window so words aren't torn in half; falls back to a hard
/// character-count split when no whitespace is found there. All returned
/// ranges are re-trimmed, so a piece that happens to be all whitespace is
/// dropped rather than yielding an empty block.
fn split_long_block(text: &str, start: usize, end: usize, max_chars: usize) -> Vec<(usize, usize)> {
    let core = &text[start..end];
    if core.chars().count() <= max_chars {
        return vec![(start, end)];
    }

    // Byte offset (relative to `core`) of the start of each char, plus a
    // trailing sentinel at `core.len()` so char index `total_chars`
    // resolves to the end of the block. `char_indices` guarantees every
    // offset here lands on a char boundary.
    let mut char_byte_offsets: Vec<usize> = core.char_indices().map(|(i, _)| i).collect();
    char_byte_offsets.push(core.len());
    let chars: Vec<char> = core.chars().collect();
    let total_chars = chars.len();

    let mut pieces = Vec::new();
    let mut piece_start = 0usize;
    while piece_start < total_chars {
        let hard_limit = (piece_start + max_chars).min(total_chars);
        let mut split_at = hard_limit;
        if hard_limit < total_chars {
            // Search backward for a whitespace char, but don't search past
            // the halfway point of this piece — avoids a tiny leading
            // fragment when whitespace is sparse.
            let search_floor = piece_start + max_chars / 2;
            let mut j = hard_limit;
            while j > search_floor {
                j -= 1;
                if chars[j].is_whitespace() {
                    split_at = j + 1; // keep the whitespace with the earlier piece
                    break;
                }
            }
        }

        let piece_start_byte = start + char_byte_offsets[piece_start];
        let piece_end_byte = start + char_byte_offsets[split_at];
        let (trimmed_start, trimmed_end) = trim_range(text, piece_start_byte, piece_end_byte);
        if trimmed_start < trimmed_end {
            pieces.push((trimmed_start, trimmed_end));
        }
        piece_start = split_at;
    }
    pieces
}

/// Merge adjacent blocks (in order) until the count is `<= cap`, without
/// ever producing a merged block whose core text exceeds `max_chars`.
///
/// - First tries the original even-distribution merge (blocks divided into
///   exactly `cap` groups, sized as evenly as possible, first `n % cap`
///   groups get one extra block). This is used whenever every resulting
///   group fits within `max_chars`, which is the common case (many small
///   blocks) and matches the pre-size-cap merge behaviour exactly.
/// - If that distribution would put more than `max_chars` of text into any
///   group, falls back to a left-to-right greedy merge: adjacent blocks are
///   combined only while the running total stays within `max_chars`. For
///   blocks that must stay in order, this greedy pass yields the fewest
///   possible groups — optimal, not just "good enough".
/// - If even the greedy merge can't bring the count down to `cap` (e.g. an
///   entry with hundreds of near-`max_chars` blocks), the tail is dropped:
///   only the first `cap` groups are kept. This is a deliberate coverage
///   truncation for pathologically huge entries — every kept group is still
///   `<= max_chars`, so total indexed text is bounded at `cap * max_chars`.
fn cap_blocks(
    text: &str,
    blocks: Vec<(usize, usize)>,
    cap: usize,
    max_chars: usize,
) -> Vec<(usize, usize)> {
    let n = blocks.len();
    if n <= cap || cap == 0 {
        return blocks;
    }

    let even = even_distribution_merge(&blocks, cap);
    if even.iter().all(|&(s, e)| char_len(text, s, e) <= max_chars) {
        return even;
    }

    let mut greedy = greedy_size_aware_merge(text, &blocks, max_chars);
    if greedy.len() > cap {
        greedy.truncate(cap);
    }
    greedy
}

/// Distribute `blocks` evenly into exactly `cap` groups (the first
/// `n % cap` groups get one extra block), merging each group into a single
/// `(start, end)` range. Deterministic; every original block contributes to
/// exactly one output block.
fn even_distribution_merge(blocks: &[(usize, usize)], cap: usize) -> Vec<(usize, usize)> {
    let n = blocks.len();
    let base = n / cap;
    let remainder = n % cap;
    let mut merged = Vec::with_capacity(cap);
    let mut idx = 0;
    for i in 0..cap {
        let size = if i < remainder { base + 1 } else { base };
        let group = &blocks[idx..idx + size];
        merged.push((group.first().unwrap().0, group.last().unwrap().1));
        idx += size;
    }
    merged
}

/// Greedily merge adjacent blocks left-to-right, only combining while the
/// running combined length stays `<= max_chars`. Never produces a group
/// over the limit; yields the minimum possible group count for in-order
/// contiguous merging (may still be `> cap`, handled by the caller).
fn greedy_size_aware_merge(
    text: &str,
    blocks: &[(usize, usize)],
    max_chars: usize,
) -> Vec<(usize, usize)> {
    let mut merged = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for &(start, end) in blocks {
        current = Some(match current {
            None => (start, end),
            Some((cur_start, _)) if char_len(text, cur_start, end) <= max_chars => (cur_start, end),
            Some(finished) => {
                merged.push(finished);
                (start, end)
            }
        });
    }
    if let Some(last) = current {
        merged.push(last);
    }
    merged
}

/// Count of Unicode scalar values in `text[start..end]`.
fn char_len(text: &str, start: usize, end: usize) -> usize {
    text[start..end].chars().count()
}

pub(crate) fn truncate_preview(core: &str) -> String {
    let normalized = normalize_whitespace(core);
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() <= PREVIEW_MAX_CHARS {
        normalized
    } else {
        let mut truncated: String = chars[..PREVIEW_MAX_CHARS].iter().collect();
        truncated.push('…');
        truncated
    }
}

/// Trim + collapse internal whitespace runs to a single space. This is the
/// "normalized" form used both for hashing and for previews.
fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Version salt mixed into every hash [`hash_normalized`] produces, so a
/// change to what bytes actually get sent to the embedder for a given core
/// invalidates every already-embedded row by making its stored
/// `content_hash` mismatch what this build recomputes — the diff planner
/// (`ai::indexer::plan_chunk_diff`) then re-embeds it naturally, with no
/// migration code and no manual wipe. **Bump this constant** whenever the
/// embed-input shape changes, even if the change looks unrelated to
/// hashing. Two precedents that needed a bump but didn't get one (found
/// together in the same review, both silent permanent false-cache-hit
/// bugs until this salt was added): removing the 40-char overlap prefix
/// from `Chunk::text` (I1, this module) — before I1, `text` was
/// `overlap + core` but `content_hash` was always computed from `core`
/// alone, so an already-embedded row's vector (from `overlap + core`) kept
/// matching the same hash after I1 switched `text` to `core` alone, even
/// though the bytes an embed call would now send for that core had
/// changed; and prepending provider task prefixes (`passage: ` / `query: `
/// / `search_document: `) at the on-device embedder's inference boundary
/// (E5/Nomic, commit 79a00df3), which changed the embedded bytes for every
/// existing row while this hash never moved.
const CHUNK_HASH_VERSION: &str = "v2";

fn hash_normalized(core: &str) -> String {
    let normalized = normalize_whitespace(core);
    let mut hasher = Sha256::new();
    hasher.update(CHUNK_HASH_VERSION.as_bytes());
    // Null-byte separator: normalization can never itself produce a null
    // byte (whitespace runs collapse to a single space), so this can't be
    // ambiguous with a differently-split version/content boundary.
    hasher.update(b"\0");
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

/// Deterministic hash of the normalized text — the same algorithm each
/// [`Chunk::content_hash`] uses for a single chunk's core text, applied here
/// to a whole canonical entry text (`title + "\n\n" + content_text`, see
/// [`crate::ai::indexer::build_indexable_text`]). Used by the save-path
/// dirty-marking hook for `entry_embedding_jobs.content_hash`, which is
/// semantically "hash of the whole title+content_text", not a per-chunk hash.
pub fn content_hash(text: &str) -> String {
    hash_normalized(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking_empty_text_returns_zero_chunks() {
        assert_eq!(chunk_indexable_text("").len(), 0);
        assert_eq!(chunk_indexable_text("   \n\n  ").len(), 0);
    }

    #[test]
    fn chunking_short_text_returns_one_chunk() {
        let chunks = chunk_indexable_text("Short entry");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_index, 0);
        assert_eq!(chunks[0].char_start, 0);
        assert_eq!(chunks[0].char_end, "Short entry".len());
        assert_eq!(chunks[0].text, "Short entry");
    }

    #[test]
    fn chunking_under_20_chars_is_still_one_chunk() {
        let chunks = chunk_indexable_text("hi there");
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn chunking_multi_paragraph_splits_on_blank_lines_with_valid_offsets() {
        let text =
            "Title\n\nFirst paragraph body.\n\nSecond paragraph body.\n\nThird paragraph body.";
        let chunks = chunk_indexable_text(text);
        assert_eq!(chunks.len(), 4, "title + 3 paragraphs = 4 blocks");

        // Offsets map back into the source: slicing text[char_start..char_end]
        // reproduces exactly the chunk's `text` — no overlap, no
        // cross-chunk contamination.
        for chunk in &chunks {
            let core = &text[chunk.char_start..chunk.char_end];
            assert_eq!(
                chunk.text, core,
                "chunk.text must equal its own core slice exactly"
            );
        }
        assert_eq!(&text[chunks[0].char_start..chunks[0].char_end], "Title");
        assert_eq!(
            &text[chunks[1].char_start..chunks[1].char_end],
            "First paragraph body."
        );
        assert_eq!(
            &text[chunks[3].char_start..chunks[3].char_end],
            "Third paragraph body."
        );
    }

    #[test]
    fn chunking_heading_and_list_items_form_their_own_blocks() {
        let text =
            "# Heading\nIntro line right after heading.\n- item one\n- item two\n- item three";
        let chunks = chunk_indexable_text(text);
        // heading, intro paragraph, and the whole compact list as one
        // cohesive block (each is its own boundary, separate from the rest).
        assert_eq!(chunks.len(), 3);
        assert_eq!(&text[chunks[0].char_start..chunks[0].char_end], "# Heading");
        assert_eq!(
            &text[chunks[1].char_start..chunks[1].char_end],
            "Intro line right after heading."
        );
        assert_eq!(
            &text[chunks[2].char_start..chunks[2].char_end],
            "- item one\n- item two\n- item three"
        );
    }

    // --- I1: chunk text carries no overlap — hash⇔vector identity -----

    /// Core invariant (I1 fix): `Chunk::text` is exactly the bytes
    /// `content_hash` was computed from — no borrowed overlap prefix from a
    /// neighboring chunk. Before the fix, every non-first chunk's `text`
    /// carried a borrowed prefix while `content_hash` covered only its own
    /// core, so this failed for chunk 1 onward.
    #[test]
    fn chunking_every_chunk_text_hashes_to_its_own_content_hash() {
        let text =
            "Title\n\nFirst paragraph body.\n\nSecond paragraph body.\n\nThird paragraph body.";
        let chunks = chunk_indexable_text(text);
        assert!(
            chunks.len() > 1,
            "need multiple chunks to exercise the invariant"
        );
        for chunk in &chunks {
            assert_eq!(
                content_hash(&chunk.text),
                chunk.content_hash,
                "chunk.text must hash to exactly chunk.content_hash: {:?}",
                chunk.text
            );
        }
    }

    /// I1 fix: editing only the TAIL of paragraph N must leave paragraph
    /// N+1's `text` (not just its hash) completely unchanged. Before the
    /// fix, chunk N+1's `text` silently borrowed N's tail as overlap, so an
    /// edit near N's end changed N+1's real embed input while its
    /// (core-only) hash stayed stable — the cache-identity bug this fix
    /// closes.
    #[test]
    fn chunking_editing_tail_of_paragraph_leaves_next_chunk_text_and_hash_unchanged() {
        let original = "Paragraph one original tail.\n\nParagraph two text.";
        let edited = "Paragraph one EDITED tail.\n\nParagraph two text.";

        let original_chunks = chunk_indexable_text(original);
        let edited_chunks = chunk_indexable_text(edited);

        assert_eq!(original_chunks.len(), 2);
        assert_eq!(edited_chunks.len(), 2);
        assert_eq!(
            original_chunks[1].text, edited_chunks[1].text,
            "next chunk's text must not change when only the previous paragraph's tail changes"
        );
        assert_eq!(
            original_chunks[1].content_hash, edited_chunks[1].content_hash,
            "next chunk's hash must not change either"
        );
    }

    /// The core token-saving guarantee: editing exactly one paragraph must
    /// change exactly that paragraph's chunk hash and leave every other
    /// chunk's hash untouched.
    #[test]
    fn chunking_editing_one_paragraph_changes_only_that_chunks_hash() {
        let original =
            "Paragraph one text.\n\nParagraph two original text.\n\nParagraph three text.";
        let edited =
            "Paragraph one text.\n\nParagraph two EDITED text now.\n\nParagraph three text.";

        let original_chunks = chunk_indexable_text(original);
        let edited_chunks = chunk_indexable_text(edited);

        assert_eq!(original_chunks.len(), 3);
        assert_eq!(edited_chunks.len(), 3);

        assert_eq!(
            original_chunks[0].content_hash, edited_chunks[0].content_hash,
            "paragraph one is untouched"
        );
        assert_ne!(
            original_chunks[1].content_hash, edited_chunks[1].content_hash,
            "paragraph two was edited"
        );
        assert_eq!(
            original_chunks[2].content_hash, edited_chunks[2].content_hash,
            "paragraph three is untouched"
        );
    }

    #[test]
    fn chunking_caps_at_max_chunks() {
        let mut paragraphs = Vec::new();
        for i in 0..200 {
            paragraphs.push(format!("Paragraph number {i} with some body text."));
        }
        let text = paragraphs.join("\n\n");

        let chunks = chunk_indexable_text(&text);
        assert!(chunks.len() <= AI_ENTRY_MAX_CHUNKS);
        assert_eq!(chunks.len(), AI_ENTRY_MAX_CHUNKS);

        // chunk_index is contiguous starting at 0.
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.chunk_index, i);
        }
        // Every original paragraph is still represented: the first and
        // last chunk's offsets must reach the very start/end of the text.
        assert_eq!(chunks.first().unwrap().char_start, 0);
        assert_eq!(chunks.last().unwrap().char_end, text.len());
    }

    #[test]
    fn chunking_content_hash_is_deterministic() {
        let text = "Alpha paragraph.\n\nBeta paragraph.";
        let a = chunk_indexable_text(text);
        let b = chunk_indexable_text(text);
        assert_eq!(a.len(), b.len());
        for (ca, cb) in a.iter().zip(b.iter()) {
            assert_eq!(ca.content_hash, cb.content_hash);
        }
    }

    #[test]
    fn chunking_normalization_ignores_whitespace_only_differences() {
        let tight = "Alpha paragraph.\n\nBeta   paragraph   here.";
        let spaced = "Alpha paragraph.\n\nBeta paragraph here.";

        let a = chunk_indexable_text(tight);
        let b = chunk_indexable_text(spaced);
        assert_eq!(a.len(), 2);
        assert_eq!(b.len(), 2);
        assert_eq!(
            a[1].content_hash, b[1].content_hash,
            "whitespace-only differences must hash identically"
        );
    }

    // --- CHUNK_HASH_VERSION: bumping the salt invalidates every hash ----

    /// The whole point of [`CHUNK_HASH_VERSION`]: for the SAME normalized
    /// core, `hash_normalized` must produce a DIFFERENT hash than the raw
    /// SHA-256 of the normalized text alone (i.e. than what an unsalted
    /// build, or a build with a different version string, would compute).
    /// This is the regression guard for the fix itself — if someone strips
    /// the salt back out (or a future refactor accidentally bypasses it),
    /// this test starts failing loudly instead of silently reintroducing
    /// the permanent-false-cache-hit bug the salt closes.
    #[test]
    fn content_hash_differs_from_unsalted_sha256_of_normalized_core() {
        let core = "Alpha paragraph.";
        let salted = content_hash(core);

        let mut hasher = Sha256::new();
        hasher.update(core.as_bytes());
        let unsalted = hex::encode(hasher.finalize());

        assert_ne!(
            salted, unsalted,
            "content_hash must be salted by CHUNK_HASH_VERSION, not a bare hash of the core"
        );
    }

    /// A future bump of `CHUNK_HASH_VERSION` must change every hash for
    /// otherwise-identical input — this is what makes bumping the constant
    /// alone sufficient to invalidate every previously-embedded row,
    /// without touching the hashing logic itself. Simulated here by
    /// hashing the same core under two different version strings using the
    /// same construction `hash_normalized` uses internally.
    #[test]
    fn different_version_salt_changes_the_hash_for_identical_core() {
        fn hash_with_version(version: &str, core: &str) -> String {
            // Same `normalize_whitespace` the real function uses (not just
            // `trim()`) — otherwise the sanity assert below would only
            // happen to pass for fixtures with no collapsible internal
            // whitespace, and silently stop being a faithful simulation.
            let normalized = normalize_whitespace(core);
            let mut hasher = Sha256::new();
            hasher.update(version.as_bytes());
            hasher.update(b"\0");
            hasher.update(normalized.as_bytes());
            hex::encode(hasher.finalize())
        }

        let core = "Some paragraph text.";
        let v1 = hash_with_version("v1", core);
        let v2 = hash_with_version("v2", core);
        assert_ne!(
            v1, v2,
            "different version salts must produce different hashes for the same core"
        );
        // Sanity: the real function must match this construction for the
        // CURRENT version, proving the simulation above is faithful to
        // `hash_normalized`'s actual algorithm.
        assert_eq!(
            content_hash(core),
            hash_with_version(CHUNK_HASH_VERSION, core)
        );
    }

    // --- C1: real extractPlainText format (single `\n` per block) -----

    /// `extractPlainText` (`src/lib/yjs.ts`) joins TipTap blocks with a
    /// single `\n` per block, NOT `\n\n` — `build_indexable_text` then
    /// prepends `"{title}\n\n{content_text}"`. This is the real shape
    /// indexing sees. Verify granularity matches "one paragraph = one
    /// chunk", not "whole body = one chunk" (the bug this test guards).
    #[test]
    fn chunking_real_extraction_format_splits_one_chunk_per_paragraph() {
        let text = "Title\n\nParagraph one.\nParagraph two.\nParagraph three.";
        let chunks = chunk_indexable_text(text);
        assert_eq!(
            chunks.len(),
            4,
            "title + 3 single-newline-joined paragraphs"
        );
        assert_eq!(&text[chunks[0].char_start..chunks[0].char_end], "Title");
        assert_eq!(
            &text[chunks[1].char_start..chunks[1].char_end],
            "Paragraph one."
        );
        assert_eq!(
            &text[chunks[2].char_start..chunks[2].char_end],
            "Paragraph two."
        );
        assert_eq!(
            &text[chunks[3].char_start..chunks[3].char_end],
            "Paragraph three."
        );
    }

    /// Same real-extraction shape as above: editing exactly one middle
    /// paragraph must change only that paragraph's chunk hash — the
    /// token-saving guarantee, exercised against single-`\n` input instead
    /// of the hand-written `\n\n` fixtures used elsewhere in this file.
    #[test]
    fn chunking_real_extraction_format_editing_middle_paragraph_changes_only_that_hash() {
        let original = "Title\n\nParagraph one.\nParagraph two original.\nParagraph three.";
        let edited = "Title\n\nParagraph one.\nParagraph two EDITED.\nParagraph three.";

        let original_chunks = chunk_indexable_text(original);
        let edited_chunks = chunk_indexable_text(edited);

        assert_eq!(original_chunks.len(), 4);
        assert_eq!(edited_chunks.len(), 4);
        assert_eq!(
            original_chunks[0].content_hash, edited_chunks[0].content_hash,
            "title is untouched"
        );
        assert_eq!(
            original_chunks[1].content_hash, edited_chunks[1].content_hash,
            "paragraph one is untouched"
        );
        assert_ne!(
            original_chunks[2].content_hash, edited_chunks[2].content_hash,
            "paragraph two was edited"
        );
        assert_eq!(
            original_chunks[3].content_hash, edited_chunks[3].content_hash,
            "paragraph three is untouched"
        );
    }

    // --- C2: bounded per-chunk size -----------------------------------

    /// A single >10,000-char "paragraph" (no line breaks) containing
    /// multi-byte Vietnamese text — a naive byte-offset split would panic
    /// or corrupt characters. Must split into multiple chunks, each
    /// `<= AI_CHUNK_MAX_CHARS` core chars, with offsets that still slice
    /// back to the exact core (proves char-boundary safety).
    #[test]
    fn chunking_oversized_block_splits_into_max_chars_pieces_with_utf8_safety() {
        let sentence = "Đây là một câu tiếng Việt có dấu, dùng để kiểm tra ranh giới ký tự. ";
        let mut text = String::new();
        while text.chars().count() < 10_000 {
            text.push_str(sentence);
        }
        assert!(text.chars().count() >= 10_000);

        let chunks = chunk_indexable_text(&text);
        assert!(chunks.len() > 1, "must split into multiple chunks");
        for chunk in &chunks {
            let core = &text[chunk.char_start..chunk.char_end];
            assert!(
                core.chars().count() <= AI_CHUNK_MAX_CHARS,
                "chunk core exceeds AI_CHUNK_MAX_CHARS: {} chars",
                core.chars().count()
            );
        }
    }

    /// A single block whose core text is EXACTLY `AI_CHUNK_MAX_CHARS` chars
    /// must NOT be split — `split_long_block` only splits when the count is
    /// strictly greater than the limit.
    #[test]
    fn chunking_block_at_exactly_max_chars_is_not_split() {
        let text = "a".repeat(AI_CHUNK_MAX_CHARS);
        let chunks = chunk_indexable_text(&text);
        assert_eq!(chunks.len(), 1, "exactly at the limit must stay one chunk");
        assert_eq!(
            text[chunks[0].char_start..chunks[0].char_end]
                .chars()
                .count(),
            AI_CHUNK_MAX_CHARS
        );
    }

    /// One char over `AI_CHUNK_MAX_CHARS` must split into exactly two
    /// pieces, each within the cap.
    #[test]
    fn chunking_block_one_over_max_chars_splits_into_two() {
        let text = "a".repeat(AI_CHUNK_MAX_CHARS + 1);
        let chunks = chunk_indexable_text(&text);
        assert_eq!(
            chunks.len(),
            2,
            "one char over the limit must split into two pieces"
        );
        let mut total_chars = 0usize;
        for chunk in &chunks {
            let core_len = text[chunk.char_start..chunk.char_end].chars().count();
            assert!(core_len <= AI_CHUNK_MAX_CHARS, "piece exceeds the cap");
            assert!(core_len > 0, "no empty piece");
            total_chars += core_len;
        }
        assert_eq!(
            total_chars,
            AI_CHUNK_MAX_CHARS + 1,
            "no content dropped across the split"
        );
    }

    /// A multi-byte Vietnamese combining-diacritic sequence and an emoji
    /// (itself a multi-codepoint grapheme cluster) sitting exactly at the
    /// `AI_CHUNK_MAX_CHARS` split boundary must never panic, and every
    /// resulting piece must be sliceable as valid UTF-8 (guaranteed by
    /// slicing only at `char_indices()` boundaries — this test proves that
    /// holds even when the boundary lands inside a combining sequence /
    /// emoji rather than at a plain ASCII char).
    #[test]
    fn chunking_split_boundary_through_combining_chars_and_emoji_is_utf8_safe() {
        // "a" + combining acute accent (U+0301) — decomposed form, two
        // `char`s (two Unicode scalar values) that together render as one
        // grapheme. Repeated so the boundary at `AI_CHUNK_MAX_CHARS` chars
        // lands mid-sequence rather than neatly between graphemes.
        let combining_pair = "a\u{0301}";
        let mut text = String::new();
        while text.chars().count() < AI_CHUNK_MAX_CHARS + 10 {
            text.push_str(combining_pair);
        }
        // Land an emoji (multi-codepoint: base + variation selector) right
        // at the boundary too.
        text.push_str("❤️"); // U+2764 U+FE0F — two chars

        let chunks = chunk_indexable_text(&text);
        assert!(chunks.len() >= 2, "must split, boundary lands mid-sequence");
        for chunk in &chunks {
            // Slicing panics on a non-char-boundary index — reaching this
            // line at all proves every offset is a valid UTF-8 boundary.
            let core = &text[chunk.char_start..chunk.char_end];
            assert!(core.chars().count() > 0, "no empty piece");
            // Round-trips through String without loss — valid UTF-8.
            assert_eq!(core, core.to_string());
        }
    }

    /// Worst case: hundreds of paragraphs, each already over
    /// `AI_CHUNK_MAX_CHARS`, so both the size split and the chunk-count cap
    /// engage. Total indexed text must never exceed
    /// `AI_ENTRY_MAX_CHUNKS * AI_CHUNK_MAX_CHARS`, and no individual chunk
    /// may exceed `AI_CHUNK_MAX_CHARS`, regardless of input size.
    #[test]
    fn chunking_worst_case_total_chars_bounded_by_cap_times_max_chars() {
        let long_paragraph: String = "word ".repeat(500); // ~2500 chars
        let paragraphs: Vec<String> = (0..500).map(|_| long_paragraph.clone()).collect();
        let text = paragraphs.join("\n\n");

        let chunks = chunk_indexable_text(&text);
        assert!(chunks.len() <= AI_ENTRY_MAX_CHUNKS);

        let mut total_chars = 0usize;
        for chunk in &chunks {
            let core_len = text[chunk.char_start..chunk.char_end].chars().count();
            assert!(
                core_len <= AI_CHUNK_MAX_CHARS,
                "chunk core exceeds AI_CHUNK_MAX_CHARS: {core_len}"
            );
            total_chars += core_len;
        }
        assert!(
            total_chars <= AI_ENTRY_MAX_CHUNKS * AI_CHUNK_MAX_CHARS,
            "total indexed chars {total_chars} exceeds worst-case bound"
        );
    }

    /// 12 near-`AI_CHUNK_MAX_CHARS` blocks (any two of which would exceed
    /// the limit if paired) followed by 58 tiny blocks (which pack many to
    /// a group). Even distribution would pair up the big blocks and blow
    /// the char limit; the size-aware fallback must still bring the count
    /// under `AI_ENTRY_MAX_CHUNKS` by packing the small blocks instead —
    /// without dropping any content, proving a legal merge is preferred
    /// over the drop-tail fallback whenever one exists.
    #[test]
    fn chunking_size_aware_cap_merges_small_blocks_without_dropping_tail_when_legal() {
        let big_block = "B".repeat(AI_CHUNK_MAX_CHARS - 100);
        let small_block = "s".to_string();

        let mut paragraphs: Vec<String> = (0..12).map(|_| big_block.clone()).collect();
        paragraphs.extend((0..58).map(|_| small_block.clone()));
        let text = paragraphs.join("\n\n");

        let chunks = chunk_indexable_text(&text);
        assert!(chunks.len() <= AI_ENTRY_MAX_CHUNKS);

        for chunk in &chunks {
            let core_len = text[chunk.char_start..chunk.char_end].chars().count();
            assert!(
                core_len <= AI_CHUNK_MAX_CHARS,
                "merged chunk exceeds AI_CHUNK_MAX_CHARS: {core_len}"
            );
        }

        // No content was dropped: the last chunk still reaches the end of
        // the source text, proving the size-aware merge reached the cap
        // legally instead of falling back to truncation.
        assert_eq!(chunks.last().unwrap().char_end, text.len());
    }
}
