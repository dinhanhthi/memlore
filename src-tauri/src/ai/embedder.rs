//! Embedder abstraction.
//!
//! Phase 6 v2 (2026-05-07) trims this module to the bare minimum needed to
//! keep the entry-indexer + emotion-suggestion pipelines compiling while the
//! AI layer is rewired around external providers (see SPECIFICATION.md →
//! "Phase 6 — AI & Intelligence (External Provider model)").
//!
//! What stayed:
//!
//! - [`Embedder`] trait — every backend implements this.
//! - [`StubEmbedder`] — deterministic SHA-256 derived vectors used by tests
//!   and the dev / opt-out path. Cosine ranks against stub vectors are
//!   structurally correct (L2-unit) but semantically meaningless — that's
//!   the explicit pre-AI behaviour.
//! - [`ProviderEmbedder`] — bridges the sync [`Embedder`] trait to the async
//!   [`crate::ai::provider::AIProvider`] embedding slot. Used by
//!   [`crate::ai::indexer::EntryIndexer`] once the user configures an
//!   external embedding provider.
//! - [`SwappableEmbedder`] — `RwLock`-backed wrapper so the indexer can
//!   hold one stable handle while the runtime swaps the inner backend
//!   (Stub → RemoteProvider when the user configures AI).
//! - [`l2_normalise_in_place`] — shared helper used by callers.
//!
//! What was removed in the pivot:
//!
//! - `OnnxEmbedder` + `build_session` + tokenizer integration (ort + tokenizers
//!   crates were dropped from Cargo.toml).
//! - Idle-eviction and lock-grace timers — the on-device model session they
//!   protected no longer exists.
//! - The `idle_for` / `touch` instrumentation — preserved as no-op stubs on
//!   `SwappableEmbedder` so the existing eviction task in `lib.rs` keeps
//!   compiling until R1's wider clean-up reaches it.

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use crate::ai::error::AiError;
use crate::ai::provider::{provider_namespaced_model_id, AIProvider};

/// Trait every embedding backend must implement. Embeddings MUST be L2-
/// normalised so callers can use a plain dot product for cosine similarity.
pub trait Embedder: Send + Sync {
    /// Stable id of the underlying backend. Phase 6 v2 uses provider-namespaced
    /// strings like `"openai:text-embedding-3-small"` so the cache key can
    /// distinguish vectors produced by different providers.
    fn model_id(&self) -> &str;

    /// Output dimensionality of every produced vector.
    fn dim(&self) -> usize;

    /// Embed a single document text to an L2-normalised vector of length [`dim`].
    /// This is the **document** side of an asymmetric retrieval pair.
    fn embed(&self, text: &str) -> Result<Vec<f32>, AiError>;

    /// Embed a query string. Asymmetric encoders (most modern retrieval
    /// models) need a different prefix on the query side. The default impl
    /// forwards to `embed` — symmetric backends (the stub, simple averaging
    /// models) keep working without overriding.
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, AiError> {
        self.embed(text)
    }
}

/// Deterministic stub embedder used by tests + the unconfigured-AI path.
///
/// 1. Hash the UTF-8 bytes of `text` via SHA-256 in counter mode.
/// 2. Each 4-byte chunk maps to one f32 via `(u32::from_le_bytes / u32::MAX) * 2 - 1`.
/// 3. L2-normalise.
///
/// Identical input → identical vector (idempotent re-indexing). Similar
/// inputs do NOT produce similar vectors — semantic relevance is zero.
pub struct StubEmbedder {
    model_id: String,
    dim: usize,
}

impl StubEmbedder {
    pub fn new(model_id: impl Into<String>, dim: usize) -> Self {
        Self {
            model_id: model_id.into(),
            dim,
        }
    }

    pub fn default_for_dev() -> Self {
        Self::new("embedding-stub-768", 768)
    }
}

impl Default for StubEmbedder {
    fn default() -> Self {
        Self::default_for_dev()
    }
}

impl Embedder for StubEmbedder {
    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let mut out = Vec::with_capacity(self.dim);
        let mut counter: u32 = 0;
        let bytes_needed = self.dim * 4;
        let mut buf: Vec<u8> = Vec::with_capacity(bytes_needed);
        while buf.len() < bytes_needed {
            let mut hasher = Sha256::new();
            hasher.update(text.as_bytes());
            hasher.update(counter.to_le_bytes());
            buf.extend_from_slice(&hasher.finalize());
            counter = counter.wrapping_add(1);
        }
        for chunk in buf.chunks_exact(4).take(self.dim) {
            let raw = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let v = (raw as f32 / (u32::MAX as f32)) * 2.0 - 1.0;
            out.push(v);
        }
        l2_normalise_in_place(&mut out);
        Ok(out)
    }
}

/// Normalise `v` to unit L2 length in place. Zero-vector input is left as
/// zeros (downstream cosine then collapses to 0 — never NaN).
pub fn l2_normalise_in_place(v: &mut [f32]) {
    let norm_sq: f32 = v.iter().map(|x| x * x).sum();
    if norm_sq <= 0.0 {
        return;
    }
    let inv = 1.0 / norm_sq.sqrt();
    for x in v.iter_mut() {
        *x *= inv;
    }
}

pub type DynEmbedder = Arc<dyn Embedder>;

/// Embedder backed by the configured external provider's embedding slot.
///
/// `Embedder::embed` is synchronous (save-path indexing runs inside sync
/// Tauri commands) while `AIProvider::embed` is async. The bridge spawns
/// a short-lived thread and drives the future with
/// `tauri::async_runtime::block_on` so we never block the WebView main
/// thread on HTTP I/O.
pub struct ProviderEmbedder {
    provider: Arc<dyn AIProvider>,
    model_id: String,
}

impl ProviderEmbedder {
    pub fn new(provider: Arc<dyn AIProvider>) -> Self {
        let model_id = provider_namespaced_model_id(provider.as_ref());
        Self { provider, model_id }
    }
}

impl Embedder for ProviderEmbedder {
    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn dim(&self) -> usize {
        // Dimension is discovered on first embed; callers that need dim
        // before any embed (rare) should query the provider docs. The
        // indexer only needs dim at upsert time, after embed returns.
        0
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let provider = Arc::clone(&self.provider);
        let text = text.to_string();
        let handle = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async move {
                crate::ai::audit::with_feature(
                    "embedding_indexer",
                    provider.embed(&[text.as_str()]),
                )
                .await
            })
        });
        let result = handle
            .join()
            .map_err(|_| AiError::IoError("embed thread panicked".into()))?;
        let mut vecs = result?;
        vecs.pop()
            .ok_or_else(|| AiError::ProviderError("embedding provider returned empty batch".into()))
    }
}

/// Build a [`DynEmbedder`] from the active embedding provider snapshot.
pub fn provider_embedder_from(provider: Arc<dyn AIProvider>) -> DynEmbedder {
    Arc::new(ProviderEmbedder::new(provider))
}

/// Default stub used when no embedding provider is configured or after
/// `dispose_embedding_service` reverts the indexer on app lock.
pub fn stub_embedder_for_indexer() -> DynEmbedder {
    Arc::new(StubEmbedder::default_for_dev())
}

/// Hot-swappable wrapper. The indexer holds one `Arc<SwappableEmbedder>`;
/// the runtime swaps the inner backend when the user configures or
/// disconnects an AI provider. Reads are lock-free (RwLock read), swaps are
/// rare (RwLock write). Poison is recovered.
pub struct SwappableEmbedder {
    inner: RwLock<DynEmbedder>,
    /// Wall-clock of the most recent successful `embed()` call, monotonic
    /// ns since process start. Kept as a no-op contract for callers that
    /// still expect the field; Phase 6 v2 has no idle eviction (no
    /// on-device session to release), so it's wired but unused.
    last_used_nanos: AtomicU64,
    process_start: Instant,
}

impl SwappableEmbedder {
    pub fn new(initial: DynEmbedder) -> Self {
        Self {
            inner: RwLock::new(initial),
            last_used_nanos: AtomicU64::new(0),
            process_start: Instant::now(),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, DynEmbedder> {
        match self.inner.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, DynEmbedder> {
        match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Replace the active backend. Returns the prior `Arc` so callers may
    /// drop heavy backends on a background thread if desired.
    pub fn swap(&self, next: DynEmbedder) -> DynEmbedder {
        let mut guard = self.write();
        std::mem::replace(&mut *guard, next)
    }

    /// Cheap snapshot — clones the inner `Arc` so callers can hold a stable
    /// reference across long-running ops without keeping the RwLock locked.
    pub fn snapshot(&self) -> DynEmbedder {
        Arc::clone(&self.read())
    }

    pub fn current_model_id(&self) -> String {
        self.read().model_id().to_string()
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let result = self.read().embed(text);
        if result.is_ok() {
            self.touch();
        }
        result
    }

    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>, AiError> {
        let result = self.read().embed_query(text);
        if result.is_ok() {
            self.touch();
        }
        result
    }

    pub fn dim(&self) -> usize {
        self.read().dim()
    }

    /// No-op outside of tests / the deprecated idle-eviction task. Recorded
    /// monotonic timestamp for callers that still poll `idle_for`.
    pub fn touch(&self) {
        let elapsed = self.process_start.elapsed().as_nanos() as u64;
        self.last_used_nanos.store(elapsed, Ordering::Relaxed);
    }

    /// Returns `None` if the embedder has never been used in this process.
    /// Callers that previously triggered idle eviction can keep the call
    /// site compiling — Phase 6 v2 doesn't need eviction since the active
    /// backend is either the stub (cheap) or a thin HTTP client (no
    /// in-memory model to release).
    pub fn idle_for(&self) -> Option<Duration> {
        let last = self.last_used_nanos.load(Ordering::Relaxed);
        if last == 0 {
            return None;
        }
        let now = self.process_start.elapsed().as_nanos() as u64;
        Some(Duration::from_nanos(now.saturating_sub(last)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_embedder_is_deterministic() {
        let e = StubEmbedder::default_for_dev();
        let v1 = e.embed("hello").unwrap();
        let v2 = e.embed("hello").unwrap();
        assert_eq!(v1, v2);
    }

    #[test]
    fn stub_embedder_output_is_l2_unit() {
        let e = StubEmbedder::default_for_dev();
        let v = e.embed("hello").unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    #[test]
    fn stub_embedder_default_dim_768() {
        let e = StubEmbedder::default_for_dev();
        assert_eq!(e.embed("x").unwrap().len(), 768);
    }

    #[test]
    fn stub_embed_query_falls_back_to_embed() {
        let e = StubEmbedder::default_for_dev();
        let q = e.embed_query("hello").unwrap();
        let d = e.embed("hello").unwrap();
        assert_eq!(q, d);
    }

    #[test]
    fn swappable_embedder_swap_returns_prior() {
        let initial: DynEmbedder = Arc::new(StubEmbedder::new("a", 64));
        let swap = SwappableEmbedder::new(initial);
        assert_eq!(swap.current_model_id(), "a");
        let next: DynEmbedder = Arc::new(StubEmbedder::new("b", 64));
        let prior = swap.swap(next);
        assert_eq!(prior.model_id(), "a");
        assert_eq!(swap.current_model_id(), "b");
    }

    #[test]
    fn l2_normalise_zero_vector_stays_zero() {
        let mut v = vec![0.0_f32; 8];
        l2_normalise_in_place(&mut v);
        assert!(v.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn provider_embedder_uses_namespaced_model_id() {
        use crate::ai::error::AiError;
        use crate::ai::provider::{AIProvider, ChatOpts, Message};
        use async_trait::async_trait;
        use std::sync::Arc;

        struct VecEmbedProvider {
            id: &'static str,
            model: &'static str,
            vec: Vec<f32>,
        }

        #[async_trait]
        impl AIProvider for VecEmbedProvider {
            fn id(&self) -> &str {
                self.id
            }
            fn display_name(&self) -> &str {
                "test"
            }
            fn embedding_model_id(&self) -> &str {
                self.model
            }
            async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
                Ok(texts.iter().map(|_| self.vec.clone()).collect())
            }
            async fn chat(&self, _m: &[Message], _o: ChatOpts) -> Result<String, AiError> {
                Ok(String::new())
            }
        }

        let provider: Arc<dyn AIProvider> = Arc::new(VecEmbedProvider {
            id: "openai",
            model: "text-embedding-3-small",
            vec: vec![1.0, 0.0, 0.0, 0.0],
        });
        let e = ProviderEmbedder::new(provider);
        assert_eq!(e.model_id(), "openai:text-embedding-3-small");
        let out = e.embed("hello").unwrap();
        assert_eq!(out, vec![1.0, 0.0, 0.0, 0.0]);
    }
}
