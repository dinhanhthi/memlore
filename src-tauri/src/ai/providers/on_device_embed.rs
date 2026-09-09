//! `on-device` embedding provider (Phase 4 Task 3, Embedding Cost
//! Guardrails) — runs `fastembed` (ONNX Runtime) in-process against a
//! model the user opted into and downloaded once via
//! [`crate::ai::on_device::download::DownloadManager`]. Embedding-only:
//! there is no on-device chat/generation path in Memlore (see
//! `CLAUDE.md`), so `chat`/`chat_stream`/`generate_image` all reject —
//! mirroring how the CLI providers reject `embed` in the other
//! direction (see `ai::providers::cli::claude::ClaudeCliProvider::embed`).
//!
//! **Not-ready handling:** `embed()` never panics and never talks to the
//! network. If the selected catalog model isn't downloaded yet, or isn't
//! backed by a `fastembed::EmbeddingModel` variant in the vendored crate
//! version (see `ai::on_device::catalog` module docs — every catalog
//! entry has a backend today, but the mechanism stays in place for any
//! future addition that doesn't), `embed()` returns
//! `AiError::ModelNotReady`, which `ai::indexer::is_auth_or_config_error`
//! classifies the same as a missing/misconfigured hosted provider: the
//! background-indexing worker pauses the job instead of burning its
//! exponential-backoff retry schedule on a call that can only ever fail
//! the same way again.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;

use crate::ai::error::AiError;
use crate::ai::on_device::catalog::{self, OnDeviceModel};
use crate::ai::on_device::download::DownloadManager;
use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, Message};

/// Provider id — the prefix in `provider_namespaced_model_id`, so the
/// composed embedding cache key is `"on-device:<catalog model id>"`.
pub const PROVIDER_ID: &str = "on-device";

/// Lazily-initialized `fastembed::TextEmbedding`, shared across `embed`
/// calls so the (expensive) ONNX session load happens at most once per
/// provider instance. `Arc`-wrapped so it can be cloned into a
/// `spawn_blocking` closure without borrowing `self` across the `.await`.
///
/// **Deliberately simple, not self-healing:** `OnceLock` caches the
/// *first* outcome, success or failure, for this provider instance's
/// whole lifetime — a transient `try_new` failure (e.g. a half-written
/// cache dir) permanently poisons this instance; retries on the same
/// instance keep re-hitting the cached `Err` instead of re-attempting
/// the load. Recovering would need a fresh provider instance (or a
/// success-only cache). Acceptable for now: `build_slot_provider`
/// (Task 4) constructs a new provider per settings load, so a poisoned
/// instance doesn't outlive much.
type EngineCell = Arc<OnceLock<Result<Arc<fastembed::TextEmbedding>, String>>>;

pub struct OnDeviceEmbedProvider {
    model_id: String,
    downloads: Arc<DownloadManager>,
    engine: EngineCell,
}

impl OnDeviceEmbedProvider {
    pub fn new(model_id: impl Into<String>, downloads: Arc<DownloadManager>) -> Self {
        Self {
            model_id: model_id.into(),
            downloads,
            engine: Arc::new(OnceLock::new()),
        }
    }

    /// The catalog entry for this provider's configured model, or the
    /// typed not-ready error if the id isn't in the catalog at all (e.g.
    /// a stale settings row from a removed catalog entry).
    fn catalog_entry(&self) -> Result<&'static OnDeviceModel, AiError> {
        catalog::find(&self.model_id).ok_or_else(|| {
            AiError::ModelNotReady(format!("unknown on-device model id: {}", self.model_id))
        })
    }

    /// `Ok(())` iff the model is both supported by this `fastembed`
    /// version and already downloaded — i.e. `embed()` can proceed
    /// straight to inference without touching the network.
    fn check_ready(&self) -> Result<&'static OnDeviceModel, AiError> {
        let model = self.catalog_entry()?;
        if !model.is_supported() {
            return Err(AiError::ModelNotReady(format!(
                "on-device model '{}' has no fastembed backend in this build yet",
                model.id
            )));
        }
        if !self.downloads.is_downloaded(model.id) {
            return Err(AiError::ModelNotReady(format!(
                "on-device model '{}' is not downloaded yet",
                model.id
            )));
        }
        Ok(model)
    }

    /// Shared embed path for both `embed` (document side) and `embed_query`
    /// (query side) — the only difference between the two is which prefix
    /// from the catalog entry gets applied before inference.
    async fn embed_with_prefix(
        &self,
        texts: &[&str],
        side: PrefixSide,
    ) -> Result<Vec<Vec<f32>>, AiError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let model = self.check_ready()?;
        let prefix = select_prefix(model, side);

        let engine_cell = self.engine.clone();
        let downloads = self.downloads.clone();
        let model_id = model.id.to_string();
        let owned_texts = apply_prefix(texts, prefix);

        let inference: Result<Vec<Vec<f32>>, String> =
            tauri::async_runtime::spawn_blocking(move || {
                let engine = engine_cell.get_or_init(|| {
                    // Re-resolved inside the blocking closure (not captured
                    // directly) because `OnDeviceModel` borrows from the
                    // 'static catalog and the closure must be 'static-owned.
                    let model = catalog::find(&model_id)
                        .expect("validated supported+downloaded by check_ready before spawning");
                    let fe_model = model
                        .fastembed_model
                        .clone()
                        .expect("check_ready already confirmed is_supported()");
                    let cache_dir = downloads.model_dir(model.id);
                    fastembed::TextEmbedding::try_new(
                        fastembed::InitOptions::new(fe_model)
                            .with_cache_dir(cache_dir)
                            .with_show_download_progress(false),
                    )
                    .map(Arc::new)
                    .map_err(|e| e.to_string())
                });
                let engine = engine.clone()?;
                // `TextEmbedding::embed` already mean-pools and L2-normalizes
                // internally (fastembed 4.9's `transformer_with_precedence`
                // always calls `common::normalize` on the pooled output) —
                // do NOT normalize again here.
                engine.embed(owned_texts, None).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("on-device embed task panicked: {e}"))
            .and_then(|r| r);

        // Everything past `check_ready()` is a runtime failure on a model
        // that IS supported and downloaded (session load blew up, or the
        // inference call itself failed) — NOT a "go download/reconfigure"
        // situation. Map to `ProviderError` (the same "transient, may
        // succeed on retry" bucket hosted providers use for 5xx/network
        // failures) rather than `ModelNotReady`, so the worker retries
        // with backoff instead of pausing on what could be a one-off
        // ONNX Runtime hiccup.
        inference.map_err(|e| AiError::ProviderError(format!("on-device embed failed: {e}")))
    }
}

/// Which side of an asymmetric embed a batch of texts is on — selects
/// `doc_prefix` vs `query_prefix` from the catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrefixSide {
    Document,
    Query,
}

/// Pick the catalog prefix for `side`. Factored out as a pure function
/// (rather than inlined at the `embed_with_prefix` call site) so a test can
/// pin `Document → doc_prefix`, `Query → query_prefix` directly — the part
/// of this fix that's otherwise easy to get backwards silently, since
/// `apply_prefix` alone can't tell a swapped-argument bug from a correct
/// call.
fn select_prefix(model: &OnDeviceModel, side: PrefixSide) -> Option<&'static str> {
    match side {
        PrefixSide::Document => model.doc_prefix,
        PrefixSide::Query => model.query_prefix,
    }
}

/// Prepend `prefix` (if any) to every text. E5/Nomic are asymmetric
/// encoders — they need a different instruction prefix depending on
/// whether the text being embedded is a document or a search query (see
/// `ai::on_device::catalog::OnDeviceModel::doc_prefix`/`query_prefix`).
/// Factored out as a pure function so the prefix logic can be unit-tested
/// without running real `fastembed` inference.
fn apply_prefix(texts: &[&str], prefix: Option<&str>) -> Vec<String> {
    match prefix {
        Some(p) => texts.iter().map(|t| format!("{p}{t}")).collect(),
        None => texts.iter().map(|s| s.to_string()).collect(),
    }
}

#[async_trait]
impl AIProvider for OnDeviceEmbedProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    fn display_name(&self) -> &str {
        "On-device"
    }

    fn embedding_model_id(&self) -> &str {
        &self.model_id
    }

    fn endpoint_host(&self) -> String {
        "on-device".into()
    }

    fn endpoint_class(&self) -> EndpointClass {
        EndpointClass::OnDevice
    }

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        self.embed_with_prefix(texts, PrefixSide::Document).await
    }

    async fn embed_query(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        self.embed_with_prefix(texts, PrefixSide::Query).await
    }

    async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
        Err(AiError::ProviderUnsupported(
            "on-device is an embedding-only provider; pair it with a hosted or CLI provider for generation".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::indexer::is_auth_or_config_error;
    use crate::ai::provider::provider_namespaced_model_id;

    /// Fresh, empty `DownloadManager` for a test — returned alongside its
    /// backing `TempDir` so the caller keeps the directory alive for the
    /// duration of the test (dropping it early would make `is_downloaded`
    /// checks meaningless).
    fn manager() -> (Arc<DownloadManager>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = Arc::new(DownloadManager::new(tmp.path().to_path_buf()));
        (mgr, tmp)
    }

    #[test]
    fn endpoint_class_is_on_device() {
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, downloads);
        assert_eq!(p.endpoint_class(), EndpointClass::OnDevice);
    }

    #[test]
    fn namespaced_model_id_is_stable_on_device_prefixed() {
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, downloads);
        assert_eq!(p.id(), "on-device");
        assert_eq!(p.embedding_model_id(), catalog::NOMIC_EMBED_TEXT_V15);
        assert_eq!(
            provider_namespaced_model_id(&p),
            format!("on-device:{}", catalog::NOMIC_EMBED_TEXT_V15)
        );
    }

    #[tokio::test]
    async fn embed_on_not_downloaded_supported_model_returns_typed_not_ready_error() {
        // nomic-embed-text-v1.5 IS supported by fastembed 4.9.1, but this
        // fresh DownloadManager has nothing on disk — must not panic, must
        // not touch the network, must return ModelNotReady.
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, downloads);
        let err = p.embed(&["hello"]).await.expect_err("must Err");
        assert!(matches!(err, AiError::ModelNotReady(_)), "got {err:?}");
        // The worker's own pause/skip classifier must treat this the same
        // way it treats a missing/misconfigured hosted provider.
        assert!(
            is_auth_or_config_error(&err),
            "not-ready must be pause-classified so the worker doesn't retry-storm"
        );
    }

    #[tokio::test]
    async fn embed_on_unknown_model_id_returns_typed_not_ready_error() {
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new("does-not-exist", downloads);
        let err = p.embed(&["hello"]).await.expect_err("must Err");
        assert!(matches!(err, AiError::ModelNotReady(_)), "got {err:?}");
        assert!(is_auth_or_config_error(&err));
    }

    #[tokio::test]
    async fn embed_empty_input_returns_empty_vec_without_readiness_check() {
        // Mirrors OpenAICompatibleProvider's empty-input short circuit —
        // even an unknown/undownloaded model shouldn't error on zero work.
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new("does-not-exist", downloads);
        let out = p.embed(&[]).await.expect("must succeed on empty input");
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn chat_is_rejected_as_unsupported() {
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, downloads);
        let err = p
            .chat(&[], ChatOpts::default())
            .await
            .expect_err("must Err");
        assert!(matches!(err, AiError::ProviderUnsupported(_)));
    }

    #[tokio::test]
    async fn embed_query_on_not_downloaded_supported_model_returns_typed_not_ready_error() {
        // Mirrors `embed_on_not_downloaded_supported_model_returns_typed_not_ready_error`
        // — `embed_query` must go through the same readiness gate as `embed`.
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, downloads);
        let err = p.embed_query(&["hello"]).await.expect_err("must Err");
        assert!(matches!(err, AiError::ModelNotReady(_)), "got {err:?}");
        assert!(is_auth_or_config_error(&err));
    }

    #[tokio::test]
    async fn embed_query_empty_input_returns_empty_vec_without_readiness_check() {
        let (downloads, _tmp) = manager();
        let p = OnDeviceEmbedProvider::new("does-not-exist", downloads);
        let out = p
            .embed_query(&[])
            .await
            .expect("must succeed on empty input");
        assert!(out.is_empty());
    }

    // ─── apply_prefix (pure function) ──────────────────────────────────────
    //
    // Real fastembed inference needs a downloaded model, so these test the
    // prefix logic directly rather than through `embed`/`embed_query`.

    #[test]
    fn apply_prefix_prepends_prefix_to_every_text() {
        let out = apply_prefix(&["hello", "xin chào"], Some("query: "));
        assert_eq!(out, vec!["query: hello", "query: xin chào"]);
    }

    #[test]
    fn apply_prefix_with_doc_prefix_uses_passage_prefix() {
        let out = apply_prefix(&["a journal entry"], Some("passage: "));
        assert_eq!(out, vec!["passage: a journal entry"]);
    }

    #[test]
    fn apply_prefix_with_none_prefix_returns_texts_unchanged() {
        let out = apply_prefix(&["hello", "world"], None);
        assert_eq!(out, vec!["hello", "world"]);
    }

    #[test]
    fn apply_prefix_on_empty_texts_returns_empty() {
        let out: Vec<String> = apply_prefix(&[], Some("query: "));
        assert!(out.is_empty());
    }

    // ─── select_prefix (pure function) ─────────────────────────────────────
    //
    // Guards the part of this fix that a passing `apply_prefix` test alone
    // can't catch: `PrefixSide::Document` must resolve to `doc_prefix`,
    // `PrefixSide::Query` to `query_prefix` — swapping the two match arms
    // would still compile and pass every other test in this file.

    #[test]
    fn select_prefix_document_side_uses_doc_prefix_for_e5_base() {
        let model = catalog::find(catalog::MULTILINGUAL_E5_BASE).unwrap();
        assert_eq!(
            select_prefix(model, PrefixSide::Document),
            Some("passage: ")
        );
    }

    #[test]
    fn select_prefix_query_side_uses_query_prefix_for_e5_base() {
        let model = catalog::find(catalog::MULTILINGUAL_E5_BASE).unwrap();
        assert_eq!(select_prefix(model, PrefixSide::Query), Some("query: "));
    }

    #[test]
    fn select_prefix_document_side_uses_doc_prefix_for_nomic() {
        let model = catalog::find(catalog::NOMIC_EMBED_TEXT_V15).unwrap();
        assert_eq!(
            select_prefix(model, PrefixSide::Document),
            Some("search_document: ")
        );
    }

    #[test]
    fn select_prefix_query_side_uses_query_prefix_for_nomic() {
        let model = catalog::find(catalog::NOMIC_EMBED_TEXT_V15).unwrap();
        assert_eq!(
            select_prefix(model, PrefixSide::Query),
            Some("search_query: ")
        );
    }

    /// Real-inference smoke test — requires a real `fastembed` model
    /// download (network + several hundred MB), so it's excluded from the
    /// normal suite. Opt in with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_nomic_embed_smoke() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = Arc::new(DownloadManager::new(tmp.path().to_path_buf()));
        mgr.start_download(
            catalog::NOMIC_EMBED_TEXT_V15,
            &crate::ai::on_device::download::FastembedFetcher,
        )
        .expect("real download must succeed");
        let p = OnDeviceEmbedProvider::new(catalog::NOMIC_EMBED_TEXT_V15, mgr);
        let out = p
            .embed(&["hello world", "xin chào"])
            .await
            .expect("must succeed once downloaded");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), 768);
    }
}
