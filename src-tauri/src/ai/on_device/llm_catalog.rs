//! On-device **LLM** chat model catalog — single-file Gemma 4 GGUF pins.
//!
//! This is the backend source of truth for the on-device *generation* model
//! picker (Phase 1 Task 2). Unlike [`super::catalog`] (embeddings), these
//! models are downloaded as raw `.gguf` files and served to a `llama-server`
//! sidecar via the OpenAI-compatible HTTP boundary — there is no `fastembed`
//! indirection here, so the exact file bytes matter: `gguf_url`, `sha256`,
//! and `download_size_bytes` are all **verified live against the Hugging Face
//! API** and must not drift without a re-pin.
//!
//! # Pinning policy
//!
//! All three entries point at the **official Google QAT q4_0 GGUF** repos on
//! Hugging Face (single-file, not split shards). QAT (Quantization-Aware
//! Training) q4_0 keeps near-bfloat16 quality at roughly 3x lower memory than
//! the unquantized weights, which is what makes the 12B variant fit on a 16 GB
//! machine at all. Each pin was resolved from
//! `https://huggingface.co/api/models/<repo>?blobs=true` and the
//! `resolve/<commit-sha>/<file>` URL was confirmed to 302 to the CDN with a
//! matching `x-linked-size`. Sizes/sha256 below are the LFS pointers, not the
//! redirect headers — LFS pointers are immutable per file content.
//!
//! **The `gguf_url` is pinned to an immutable commit SHA, NOT `main`.** A
//! URL that resolves against the repo's `main` branch (the mutable default
//! ref) would follow a silent upstream re-upload (Google re-publishing the
//! same filename with new bytes), changing what the URL returns while our
//! pinned `sha256` stayed old — every new install would then fail
//! `download_sha256_mismatch` permanently with no code change on our side.
//! Pinning to `resolve/<commit-sha>/<file>` freezes the bytes the URL resolves
//! to: a `main`-branch re-upload can't move a commit SHA, so the URL keeps
//! returning the exact bytes the `sha256` matches. A deliberate upstream bump
//! requires re-pinning both the SHA and the commit here.
//!
//! # Context cap
//!
//! Every entry caps [`OnDeviceLlmModel::context_tokens`] at 8192 even when the
//! underlying model supports more. Gemma 4 natively supports a much longer
//! context, but on a laptop the KV cache (not the weights) is what blows the
//! RAM budget, so we clamp at a sane journal-entry-scale window. The cap is
//! enforced by a test.
//!
//! # Public access (not gated)
//!
//! The three Google `*-qat-q4_0-gguf` repos pinned here are publicly
//! downloadable without authentication — Google published them as intentional
//! public mirrors for llama.cpp/ollama use. This was verified anonymously as of
//! 2026-07-24: the E4B `resolve` URL returns HTTP 302 → CDN (`user_id=public`)
//! → HTTP 200 `application/octet-stream`, the first 8 fetched bytes are the
//! GGUF magic (`4747 5546 0300 0000` = "GGUF" v3, not a login page), and the
//! CDN `x-linked-size` matches the pinned byte count exactly. The HF API
//! reports `"gated": false, "private": false` for all three repos. (This is
//! unlike Google's main `gemma-2-9b` etc. repos, which *are* gated.) The JIT
//! downloader therefore uses plain unauthenticated HTTP against these URLs,
//! and that is by design.
//!
//! The URLs are pinned to **immutable commit SHAs** (not `main`) — see the
//! Pinning policy section above — so a silent upstream re-upload can't break
//! installs by changing the bytes under a stable filename.

use std::sync::OnceLock;

/// Catalog id for Gemma 4 E2B (2B effective params, lightest) — QAT q4_0.
pub const GEMMA_4_E2B_IT: &str = "gemma-4-e2b-it";
/// Catalog id for Gemma 4 E4B (4B effective params) — QAT q4_0. The
/// **recommended default**: best quality-per-RAM on typical 8 GB+ laptops.
pub const GEMMA_4_E4B_IT: &str = "gemma-4-e4b-it";
/// Catalog id for Gemma 4 12B (full size) — QAT q4_0. Best quality, needs 16 GB.
pub const GEMMA_4_12B_IT: &str = "gemma-4-12b-it";

/// One on-device LLM catalog entry: the decision metadata the UI shows before
/// the user commits to a multi-GB download, plus the exact pin the downloader
/// needs to fetch and verify the file.
///
/// Mirrors the shape of [`super::catalog::OnDeviceModel`] only loosely — LLM
/// entries have no embedding dims, no task prefixes, and no `fastembed`
/// backend; instead they carry the immutable GGUF pin (`gguf_url` + `sha256` +
/// `download_size_bytes`) that the JIT downloader verifies post-fetch.
#[derive(Debug, Clone, PartialEq)]
pub struct OnDeviceLlmModel {
    /// Stable catalog id, e.g. `"gemma-4-e4b-it"`. Never reused if a pin is
    /// swapped — bump the id instead.
    pub id: &'static str,
    /// Human-readable name for the picker row.
    pub display_name: &'static str,
    /// Single-file GGUF `resolve` URL on huggingface.co, pinned to an
    /// **immutable commit SHA** (not `main`): the path is `resolve/<40-hex
    /// sha>/<file>.gguf`. Pinning to a commit SHA means a silent upstream
    /// re-upload (same filename, new bytes under `main`) can't break installs
    /// — the pinned URL always returns the same bytes the `sha256` matches.
    /// Must end in `.gguf`, start with `https://huggingface.co/`, and match
    /// `resolve/[0-9a-f]{40}/` (all enforced by tests).
    pub gguf_url: &'static str,
    /// Lowercase hex SHA-256 of the GGUF bytes at `gguf_url` (64 chars,
    /// validated by tests). The downloader rejects any fetched file whose
    /// SHA-256 doesn't match this, so a silent repo re-upload can't ship
    /// unverified weights.
    pub sha256: &'static str,
    /// Exact byte size of the GGUF at `gguf_url`, from the HF LFS pointer.
    /// Used as the denominator for byte-accurate download progress.
    pub download_size_bytes: u64,
    /// Inference context window cap, in tokens. Clamped to <= 8192 to keep the
    /// KV cache within the RAM budget implied by `min_ram_gb`.
    pub context_tokens: u32,
    /// Minimum host RAM (GB) to run this model comfortably. Static hint only —
    /// the app does not probe actual RAM (see context file: sysinfo is absent).
    pub min_ram_gb: u32,
    /// Whether this is the recommended default. Exactly one entry in the
    /// catalog has this set to `true` (enforced by test).
    pub recommended: bool,
    /// Whether the model is multilingual (Gemma 4 is multilingual, so all
    /// entries are `true`). Kept as a field rather than a constant so a future
    /// English-only addition is a one-line data change, not a logic change.
    pub multilingual: bool,
    /// One-line UI copy explaining when to pick this model.
    pub when_to_choose: &'static str,
    /// Canonical Terms of Use URL the user must be able to open before
    /// downloading. Empty string is not used — tests require `https://`.
    pub terms_url: &'static str,
    /// When true, `download_on_device_llm_model` rejects until the device
    /// has a non-empty `on_device_llm_terms_accepted_at` receipt.
    pub requires_acceptance: bool,
}

/// The full catalog, in UI/picker order (lightest → heaviest).
fn build_catalog() -> Vec<OnDeviceLlmModel> {
    vec![
        // E2B — lightest. Pin: google/gemma-4-E2B-it-qat-q4_0-gguf
        // File: gemma-4-E2B_q4_0-it.gguf
        OnDeviceLlmModel {
            id: GEMMA_4_E2B_IT,
            display_name: "Gemma 4 E2B (QAT Q4_0)",
            gguf_url: "https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/675cff42a74c774d6cb76f76d8eacb49b48c9b93/gemma-4-E2B_q4_0-it.gguf",
            sha256: "fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634",
            download_size_bytes: 3_349_516_256,
            context_tokens: 8192,
            min_ram_gb: 8,
            recommended: false,
            multilingual: true,
            when_to_choose: "Lightest and fastest; good for short entries on 8 GB machines.",
            terms_url: "https://ai.google.dev/gemma/terms",
            requires_acceptance: true,
        },
        // E4B — recommended default. Pin: google/gemma-4-E4B-it-qat-q4_0-gguf
        // File: gemma-4-E4B_q4_0-it.gguf
        OnDeviceLlmModel {
            id: GEMMA_4_E4B_IT,
            display_name: "Gemma 4 E4B (QAT Q4_0)",
            gguf_url: "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf",
            sha256: "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
            download_size_bytes: 5_154_941_280,
            context_tokens: 8192,
            min_ram_gb: 8,
            recommended: true,
            multilingual: true,
            when_to_choose: "Best balance of quality and speed; the recommended default.",
            terms_url: "https://ai.google.dev/gemma/terms",
            requires_acceptance: true,
        },
        // 12B — best quality, needs 16 GB. Pin: google/gemma-4-12B-it-qat-q4_0-gguf
        // File: gemma-4-12b-it-qat-q4_0.gguf
        OnDeviceLlmModel {
            id: GEMMA_4_12B_IT,
            display_name: "Gemma 4 12B (QAT Q4_0)",
            gguf_url: "https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/29d097773436b69ff9feafd636ab4cf873786537/gemma-4-12b-it-qat-q4_0.gguf",
            sha256: "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b",
            download_size_bytes: 6_975_879_296,
            context_tokens: 8192,
            min_ram_gb: 16,
            recommended: false,
            multilingual: true,
            when_to_choose: "Highest quality; needs a 16 GB machine for the weights + KV cache.",
            terms_url: "https://ai.google.dev/gemma/terms",
            requires_acceptance: true,
        },
    ]
}

static CATALOG: OnceLock<Vec<OnDeviceLlmModel>> = OnceLock::new();

/// The on-device LLM catalog, in picker order (lightest → heaviest).
/// Backed by a `OnceLock`, mirroring [`super::catalog::catalog`].
pub fn catalog() -> &'static [OnDeviceLlmModel] {
    CATALOG.get_or_init(build_catalog)
}

/// Look up a catalog entry by id.
pub fn find(id: &str) -> Option<&'static OnDeviceLlmModel> {
    catalog().iter().find(|m| m.id == id)
}

/// The recommended default model id (`gemma-4-e4b-it`).
pub fn default_model_id() -> &'static str {
    GEMMA_4_E4B_IT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_non_empty() {
        assert!(!catalog().is_empty(), "LLM catalog must not be empty");
    }

    #[test]
    fn exactly_one_entry_is_recommended() {
        let recommended_count = catalog().iter().filter(|m| m.recommended).count();
        assert_eq!(
            recommended_count, 1,
            "exactly one entry must be recommended, found {recommended_count}"
        );
    }

    #[test]
    fn all_ids_are_unique() {
        let mut ids: Vec<&str> = catalog().iter().map(|m| m.id).collect();
        ids.sort_unstable();
        let dupes: Vec<&str> = ids
            .windows(2)
            .filter(|w| w[0] == w[1])
            .map(|w| w[0])
            .collect();
        assert!(dupes.is_empty(), "duplicate catalog ids: {dupes:?}");
    }

    #[test]
    fn every_sha256_is_64_lowercase_hex_chars() {
        let hex = |b: u8| matches!(b, b'0'..=b'9' | b'a'..=b'f');
        for m in catalog() {
            let s = m.sha256;
            assert_eq!(
                s.len(),
                64,
                "{} sha256 must be 64 chars, got {}",
                m.id,
                s.len()
            );
            assert!(
                s.bytes().all(hex),
                "{} sha256 must be lowercase hex [0-9a-f], got {s:?}",
                m.id
            );
        }
    }

    #[test]
    fn every_gguf_url_is_a_huggingface_resolve_url_ending_in_gguf() {
        for m in catalog() {
            assert!(
                m.gguf_url.starts_with("https://huggingface.co/"),
                "{} gguf_url must start with https://huggingface.co/, got {}",
                m.id,
                m.gguf_url
            );
            assert!(
                m.gguf_url.ends_with(".gguf"),
                "{} gguf_url must end with .gguf, got {}",
                m.id,
                m.gguf_url
            );
        }
    }

    #[test]
    fn every_gguf_url_is_pinned_to_a_commit_sha() {
        // A URL that resolves against the repo's mutable `main` branch would
        // follow a silent upstream re-upload (same filename, new bytes) and
        // break every new install with download_sha256_mismatch. Pinning to an
        // immutable 40-hex commit SHA freezes the bytes the URL returns. This
        // test rejects both the mutable default ref and short/non-hex SHAs.
        let mutable_ref_segment = "/resolve/mai".to_string() + "n/";
        for m in catalog() {
            assert!(
                is_pinned_to_commit_sha(m.gguf_url),
                "{} gguf_url must be pinned to an immutable 40-hex commit SHA \
                 (resolve/<sha>/<file>.gguf), got {} — resolving against the \
                 mutable default ref would silently change bytes on an upstream \
                 re-upload",
                m.id,
                m.gguf_url
            );
            assert!(
                !m.gguf_url.contains(&mutable_ref_segment),
                "{} gguf_url must NOT resolve against the mutable default ref; \
                 pin to a commit SHA. got {}",
                m.id,
                m.gguf_url
            );
        }
    }

    /// True iff `url` is a `https://huggingface.co/<repo>/resolve/<40-hex
    /// commit sha>/<file>.gguf` URL — i.e. pinned to an immutable commit SHA,
    /// NOT the mutable `main` branch. Pure string check (no regex crate).
    fn is_pinned_to_commit_sha(url: &str) -> bool {
        let prefix = "https://huggingface.co/";
        let after_prefix = match url.strip_prefix(prefix) {
            Some(s) => s,
            None => return false,
        };
        // after_prefix = "<repo...>/resolve/<sha>/<file>.gguf"
        let resolve_marker = "/resolve/";
        let resolve_idx = match after_prefix.find(resolve_marker) {
            Some(i) => i,
            None => return false,
        };
        // There must be at least one char of <repo> before /resolve/.
        if resolve_idx == 0 {
            return false;
        }
        let after_resolve = &after_prefix[resolve_idx + resolve_marker.len()..];
        // after_resolve = "<sha>/<file>.gguf" — <sha> is the segment up to the
        // next '/', must be exactly 40 lowercase hex chars.
        let slash = match after_resolve.find('/') {
            Some(i) => i,
            None => return false,
        };
        let sha = &after_resolve[..slash];
        if sha.len() != 40
            || !sha
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return false;
        }
        // The remainder after the sha must be a non-empty `.gguf` filename.
        let file = &after_resolve[slash + 1..];
        !file.is_empty() && file.ends_with(".gguf") && !file.contains('/')
    }

    #[test]
    fn find_e4b_returns_the_recommended_entry() {
        let e4b = find(GEMMA_4_E4B_IT).expect("gemma-4-e4b-it must be in the catalog");
        assert!(
            e4b.recommended,
            "gemma-4-e4b-it must be the recommended one"
        );
    }

    #[test]
    fn find_nonexistent_returns_none() {
        assert!(find("nonexistent").is_none());
        assert!(find("").is_none());
    }

    #[test]
    fn every_context_tokens_is_within_ram_sane_cap() {
        for m in catalog() {
            assert!(
                m.context_tokens <= 8192,
                "{} context_tokens {} exceeds the 8192 RAM-sanity cap",
                m.id,
                m.context_tokens
            );
        }
    }

    #[test]
    fn default_model_id_is_the_single_recommended_entry() {
        let default_id = default_model_id();
        assert_eq!(default_id, GEMMA_4_E4B_IT);
        let default = find(default_id).expect("default id must resolve");
        assert!(default.recommended);
        assert_eq!(
            catalog().iter().filter(|m| m.recommended).count(),
            1,
            "default_model_id must point at the only recommended entry"
        );
    }

    #[test]
    fn min_ram_gb_matches_the_spec_for_each_size() {
        let e2b = find(GEMMA_4_E2B_IT).unwrap();
        assert_eq!(e2b.min_ram_gb, 8, "E2B is the light tier -> 8 GB");
        let e4b = find(GEMMA_4_E4B_IT).unwrap();
        assert_eq!(e4b.min_ram_gb, 8, "E4B is the recommended tier -> 8 GB");
        let big = find(GEMMA_4_12B_IT).unwrap();
        assert_eq!(big.min_ram_gb, 16, "12B needs 16 GB");
    }

    #[test]
    fn download_sizes_are_sane_and_ordered_by_size() {
        // Every GGUF must land in a sane byte band: all three Gemma 4 QAT q4_0
        // single-file weights are multi-GB but well under 10 GB. A pin outside
        // this band signals a wrong file (a tiny HTML login page, or a stray
        // fp16/unsplit variant).
        for m in catalog() {
            assert!(
                m.download_size_bytes > 1_000_000_000,
                "{} download_size_bytes {} is not > 1 GB — looks like the wrong file (e.g. a login page)",
                m.id,
                m.download_size_bytes
            );
            assert!(
                m.download_size_bytes < 10_000_000_000,
                "{} download_size_bytes {} is not < 10 GB — looks like the wrong variant",
                m.id,
                m.download_size_bytes
            );
        }
        // The module doc promises picker order = lightest → heaviest. Enforce
        // strict monotonic increase so a re-order or a size bump can't silently
        // desync the displayed order from the cost-to-download.
        let entries = catalog();
        assert!(
            entries.len() >= 2,
            "ordering check needs at least 2 entries, got {}",
            entries.len()
        );
        for w in entries.windows(2) {
            assert!(
                w[0].download_size_bytes < w[1].download_size_bytes,
                "catalog must be ordered lightest -> heaviest, but {} ({} bytes) is not lighter than {} ({} bytes)",
                w[0].id,
                w[0].download_size_bytes,
                w[1].id,
                w[1].download_size_bytes
            );
        }
    }

    #[test]
    fn e4b_pinned_size_matches_live_hf_value() {
        // The exact byte count the orchestrator confirmed against the HF CDN
        // `x-linked-size` header for the E4B file on 2026-07-24. Locks the pin
        // so a repo re-upload that changed the file (same name, different size)
        // would be caught here before the downloader's own sha256 check ran.
        let e4b =
            find(GEMMA_4_E4B_IT).expect("gemma-4-e4b-it must be in the catalog for this pin check");
        assert_eq!(
            e4b.download_size_bytes, 5_154_941_280,
            "E4B download_size_bytes drifted from the live-verified HF CDN value"
        );
    }

    #[test]
    fn every_entry_has_https_gemma_terms_url() {
        for m in catalog() {
            assert!(
                !m.terms_url.is_empty(),
                "{} terms_url must be present",
                m.id
            );
            assert!(
                m.terms_url.starts_with("https://"),
                "{} terms_url must be https, got {}",
                m.id,
                m.terms_url
            );
            assert_eq!(
                m.terms_url, "https://ai.google.dev/gemma/terms",
                "{} terms_url must be the Gemma ToU",
                m.id
            );
        }
    }

    #[test]
    fn every_gemma_entry_requires_acceptance() {
        for m in catalog() {
            assert!(
                m.id.starts_with("gemma-"),
                "catalog currently ships only Gemma models, got {}",
                m.id
            );
            assert!(
                m.requires_acceptance,
                "{} must require Gemma ToU acceptance before download",
                m.id
            );
        }
    }
}
