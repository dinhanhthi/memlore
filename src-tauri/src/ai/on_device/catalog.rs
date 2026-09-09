//! Recommended on-device embedding model catalog (Phase 4 Task 2).
//!
//! This is the **backend source of truth** for on-device model metadata,
//! and it MUST mirror `ON_DEVICE_MODEL_CATALOG` in
//! `src/hooks/useOnDeviceModels.ts` (Phase 3 Task 8) exactly — ids, display
//! names, dims, context lengths, download-size/RAM copy, `multilingual`,
//! and `recommended` all have to match what the shipped UI already shows,
//! or the frontend and backend would disagree about what the user is
//! about to download.
//!
//! **Catalog choice:** the multilingual E5 family (`intfloat/multilingual-e5-*`)
//! plus `nomic-embed-text-v1.5` — all four map to real `fastembed` 4.9.1
//! `EmbeddingModel` variants (checked directly against
//! `~/.cargo/registry/src/.../fastembed-4.9.1/src/models/text_embedding.rs`),
//! so every catalog entry is downloadable/usable today. An earlier catalog
//! recommended EmbeddingGemma-300M and bge-m3 as the default/best-quality
//! picks, but neither has a `fastembed` 4.9.1 backend — they were dropped
//! rather than shipping a picker with permanently-broken entries. E5 covers
//! Vietnamese (this app is Vietnamese-heavy), so `multilingual-e5-base` is
//! the new default.
//!
//! Not every catalog entry is guaranteed to have a `fastembed` backend
//! forever — the `is_supported()`/`fastembed_model: Option<_>` mechanism
//! stays in place so a future model can be added ahead of a `fastembed`
//! bump without breaking the picker.

use std::sync::OnceLock;

use fastembed::EmbeddingModel;

/// Catalog id for `multilingual-e5-base` — the recommended **default**.
/// Best balance of quality/size for multilingual (incl. Vietnamese)
/// journals.
pub const MULTILINGUAL_E5_BASE: &str = "multilingual-e5-base";
/// Catalog id for `multilingual-e5-small` — lightest multilingual option.
pub const MULTILINGUAL_E5_SMALL: &str = "multilingual-e5-small";
/// Catalog id for `multilingual-e5-large` — best multilingual quality.
pub const MULTILINGUAL_E5_LARGE: &str = "multilingual-e5-large";
/// Catalog id for `nomic-embed-text-v1.5` — English long-context option.
pub const NOMIC_EMBED_TEXT_V15: &str = "nomic-embed-text-v1.5";

/// One catalog entry: the decision metadata the UI shows before the user
/// commits to a multi-hundred-MB download.
#[derive(Debug, Clone, PartialEq)]
pub struct OnDeviceModel {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Embedding vector dimensions (full precision).
    pub dim: u32,
    /// Matryoshka (MRL) truncation options, largest-to-smallest, excluding
    /// `dim` itself. Empty when the model has no MRL support.
    pub mrl_dims: &'static [u32],
    pub context_tokens: u32,
    /// Display copy matching the Phase 3 UI, e.g. "~1.2 GB".
    pub download_size: &'static str,
    /// Approximate total download size in bytes — weight-dominated, exact
    /// figure isn't load-bearing. Used as the denominator for the on-disk
    /// dir-size download-progress poller ([`crate::ai::on_device::download`])
    /// since `fastembed`'s `hf_hub` backend has no incremental byte
    /// callback of its own.
    pub download_size_bytes: u64,
    /// Display copy matching the Phase 3 UI, e.g. "~2-3 GB".
    pub approx_ram: &'static str,
    pub multilingual: bool,
    /// Recommended default — exactly one entry is `true`.
    pub recommended: bool,
    pub when_to_choose: &'static str,
    /// The `fastembed::EmbeddingModel` variant backing this entry, or
    /// `None` if fastembed doesn't ship this model yet (see module doc).
    pub fastembed_model: Option<EmbeddingModel>,
    /// Prefix prepended to **document** texts before inference, or `None`
    /// if the model needs no task prefix. E5 (`intfloat/multilingual-e5-*`)
    /// and `nomic-embed-text-v1.5` are asymmetric encoders trained with
    /// distinct query/document instruction prefixes — skipping them
    /// degrades retrieval quality even though embedding still "works"
    /// (produces vectors, just poorly-separated ones). Applied only at the
    /// provider boundary (`OnDeviceEmbedProvider::embed`); stored chunk
    /// text and content hashes stay unprefixed.
    pub doc_prefix: Option<&'static str>,
    /// Prefix prepended to **query** texts before inference (see
    /// `doc_prefix`). Applied only in `OnDeviceEmbedProvider::embed_query`.
    pub query_prefix: Option<&'static str>,
}

impl OnDeviceModel {
    /// Whether this entry can actually be downloaded/run via `fastembed`
    /// today.
    pub fn is_supported(&self) -> bool {
        self.fastembed_model.is_some()
    }
}

/// The full catalog, in the same order as the Phase 3 UI.
fn build_catalog() -> Vec<OnDeviceModel> {
    vec![
        OnDeviceModel {
            id: MULTILINGUAL_E5_BASE,
            display_name: "multilingual-e5-base",
            dim: 768,
            mrl_dims: &[],
            context_tokens: 512,
            download_size: "~1.1 GB",
            download_size_bytes: 1_150_000_000,
            approx_ram: "~1.5-2 GB",
            multilingual: true,
            recommended: true,
            when_to_choose: "Best balance for multilingual/Vietnamese journals.",
            fastembed_model: Some(EmbeddingModel::MultilingualE5Base),
            doc_prefix: Some("passage: "),
            query_prefix: Some("query: "),
        },
        OnDeviceModel {
            id: MULTILINGUAL_E5_SMALL,
            display_name: "multilingual-e5-small",
            dim: 384,
            mrl_dims: &[],
            context_tokens: 512,
            download_size: "~470 MB",
            download_size_bytes: 470_000_000,
            approx_ram: "~0.6-1 GB",
            multilingual: true,
            recommended: false,
            when_to_choose: "Lightest multilingual option; best for low-RAM machines.",
            fastembed_model: Some(EmbeddingModel::MultilingualE5Small),
            doc_prefix: Some("passage: "),
            query_prefix: Some("query: "),
        },
        OnDeviceModel {
            id: MULTILINGUAL_E5_LARGE,
            display_name: "multilingual-e5-large",
            dim: 1024,
            mrl_dims: &[],
            context_tokens: 512,
            download_size: "~2.2 GB",
            download_size_bytes: 2_200_000_000,
            approx_ram: "~3-4 GB",
            multilingual: true,
            recommended: false,
            when_to_choose: "Highest multilingual quality; needs a capable machine.",
            fastembed_model: Some(EmbeddingModel::MultilingualE5Large),
            doc_prefix: Some("passage: "),
            query_prefix: Some("query: "),
        },
        OnDeviceModel {
            id: NOMIC_EMBED_TEXT_V15,
            display_name: "nomic-embed-text-v1.5",
            dim: 768,
            mrl_dims: &[],
            context_tokens: 8192,
            download_size: "~275 MB",
            download_size_bytes: 275_000_000,
            approx_ram: "~0.5-1 GB",
            multilingual: false,
            recommended: false,
            when_to_choose: "Long entries (8K context); strongest for English.",
            fastembed_model: Some(EmbeddingModel::NomicEmbedTextV15),
            doc_prefix: Some("search_document: "),
            query_prefix: Some("search_query: "),
        },
    ]
}

static CATALOG: OnceLock<Vec<OnDeviceModel>> = OnceLock::new();

/// The on-device model catalog, in UI order.
pub fn catalog() -> &'static [OnDeviceModel] {
    CATALOG.get_or_init(build_catalog)
}

/// Look up a catalog entry by id.
pub fn find(id: &str) -> Option<&'static OnDeviceModel> {
    catalog().iter().find(|m| m.id == id)
}

/// The recommended default model id (`multilingual-e5-base`) — keep
/// matching the shipped UI default.
pub fn default_model_id() -> &'static str {
    MULTILINGUAL_E5_BASE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_all_four_models_in_ui_order() {
        let ids: Vec<&str> = catalog().iter().map(|m| m.id).collect();
        assert_eq!(
            ids,
            vec![
                MULTILINGUAL_E5_BASE,
                MULTILINGUAL_E5_SMALL,
                MULTILINGUAL_E5_LARGE,
                NOMIC_EMBED_TEXT_V15,
            ]
        );
    }

    #[test]
    fn every_entry_has_non_empty_decision_metadata() {
        for model in catalog() {
            assert!(model.dim > 0, "{} missing dim", model.id);
            assert!(
                model.context_tokens > 0,
                "{} missing context_tokens",
                model.id
            );
            assert!(!model.download_size.is_empty(), "{} missing size", model.id);
            assert!(!model.approx_ram.is_empty(), "{} missing ram", model.id);
            assert!(
                !model.when_to_choose.is_empty(),
                "{} missing when_to_choose",
                model.id
            );
            assert!(!model.display_name.is_empty(), "{} missing name", model.id);
        }
    }

    #[test]
    fn find_looks_up_by_id_and_matches_ui_figures() {
        let large = find(MULTILINGUAL_E5_LARGE).expect("multilingual-e5-large present");
        assert_eq!(large.dim, 1024);
        assert_eq!(large.context_tokens, 512);
        assert!(large.multilingual);
        assert!(!large.recommended);

        assert!(find("does-not-exist").is_none());
    }

    #[test]
    fn default_is_multilingual_e5_base_and_is_the_only_recommended_entry() {
        assert_eq!(default_model_id(), MULTILINGUAL_E5_BASE);
        let default_model = find(default_model_id()).unwrap();
        assert!(default_model.recommended);
        assert_eq!(default_model.dim, 768);
        assert!(default_model.multilingual);
        assert_eq!(catalog().iter().filter(|m| m.recommended).count(), 1);
    }

    #[test]
    fn every_entry_has_a_positive_download_size_bytes() {
        for model in catalog() {
            assert!(
                model.download_size_bytes > 0,
                "{} missing download_size_bytes",
                model.id
            );
        }
    }

    #[test]
    fn e5_family_and_nomic_carry_their_required_asymmetric_task_prefixes() {
        // E5 and nomic are asymmetric encoders — no prefix silently degrades
        // retrieval quality instead of erroring, so this test is exhaustive
        // over the catalog rather than spot-checking one id: a future
        // catalog addition with no explicit prefix decision (`None`/`None`)
        // must fail loudly here rather than ship unprefixed by omission.
        for model in catalog() {
            let expected = if model.id == MULTILINGUAL_E5_BASE
                || model.id == MULTILINGUAL_E5_SMALL
                || model.id == MULTILINGUAL_E5_LARGE
            {
                (Some("passage: "), Some("query: "))
            } else if model.id == NOMIC_EMBED_TEXT_V15 {
                (Some("search_document: "), Some("search_query: "))
            } else {
                panic!(
                    "catalog entry '{}' has no prefix expectation wired into this test — \
                     decide its doc_prefix/query_prefix (or explicit None) before adding it",
                    model.id
                );
            };
            assert_eq!(
                (model.doc_prefix, model.query_prefix),
                expected,
                "{} has unexpected task prefixes",
                model.id
            );
        }
    }

    #[test]
    fn all_catalog_entries_have_a_fastembed_backend_today() {
        for model in catalog() {
            assert!(
                model.is_supported(),
                "{} must be supported — the whole point of this catalog is that fastembed \
                 4.9.1 ships a backend for every entry",
                model.id
            );
        }
    }
}
