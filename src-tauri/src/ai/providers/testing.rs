//! Test-only `AIProvider` implementations.
//!
//! Phase 6 v2 R4 introduces `MockAIProvider` as the canonical fake used
//! by `commands::ai::suggest_emotion` tests, R5's `semantic_search`
//! tests, and any future feature command that talks to an
//! `Arc<dyn AIProvider>`.
//!
//! Design goals:
//! - **Deterministic** — `embed(text)` returns the same vector every
//!   call for the same input. Tests can therefore predict cosine
//!   scores without spying on internals.
//! - **Inspectable** — every `embed` / `chat` / `generate_image` call
//!   is recorded so a test can assert "embedded N times", "embedded
//!   exactly these texts", "did NOT call chat", etc.
//! - **Programmable** — per-text `embed` overrides plus per-call
//!   error injection so a single mock can drive happy-path AND
//!   failure-mode tests without subclassing.
//!
//! Lives behind `#[cfg(test)]` only — never compiled into the shipped
//! binary.

#![cfg(test)]

use crate::ai::audit::{TokenUsage, TokenUsageSlot};
use crate::ai::error::AiError;
use crate::ai::provider::{AIProvider, ChatOpts, ImageOpts, Message};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

/// Records of every call made against a `MockAIProvider`. Cheap to
/// clone — tests can take a snapshot at any point.
#[derive(Debug, Default, Clone)]
pub struct MockCalls {
    pub embed_calls: Vec<Vec<String>>,
    /// Recorded separately from `embed_calls` — tests that assert a query
    /// site uses `embed_query` (not the document-side `embed`) check this
    /// field, mirroring the asymmetric-encoder distinction the real
    /// on-device provider makes.
    pub embed_query_calls: Vec<Vec<String>>,
    pub chat_calls: usize,
    pub image_calls: usize,
    /// Snapshot of the messages passed to the most-recent `chat()` call.
    /// `None` until at least one `chat()` has run. Used by tests that
    /// need to assert system-prompt content (language hint, persona).
    pub last_chat_messages: Option<Vec<Message>>,
    /// Snapshot of `crate::ai::audit::current_feature()` observed at the
    /// top of the most-recent `chat_stream()` call. Used by tests that
    /// verify the task-local feature label propagates across the
    /// `tauri::async_runtime::spawn` boundary in
    /// `stream_chat_with_fallback`. `None` until at least one
    /// `chat_stream()` has run.
    pub last_chat_stream_feature: Option<String>,
}

impl MockCalls {
    pub fn embed_count(&self) -> usize {
        self.embed_calls.len()
    }

    /// Total number of texts passed across every `embed` call. A batch
    /// of 8 prototypes counts as 1 call but 8 texts.
    pub fn total_embed_texts(&self) -> usize {
        self.embed_calls.iter().map(|c| c.len()).sum()
    }

    /// Number of `embed_query` calls (recorded separately from `embed`).
    pub fn embed_query_count(&self) -> usize {
        self.embed_query_calls.len()
    }
}

/// Configurable mock provider. Default behaviour: return a deterministic
/// 4-dim vector per input text. Tests configure specific texts via
/// [`Self::with_embedding`] when they need to pin a cosine outcome.
pub struct MockAIProvider {
    id: String,
    embedding_model_id: String,
    /// Per-text overrides — `embed("X")` returns `embeddings.get("X")`
    /// when present, otherwise `default_vector`.
    embeddings: Mutex<HashMap<String, Vec<f32>>>,
    default_vector: Vec<f32>,
    /// When `Some`, every `embed` call returns the contained error.
    /// Lets tests drive AuthFailed / RateLimited paths without changing
    /// HTTP plumbing.
    embed_error: Mutex<Option<AiError>>,
    /// Programmable chat response (R8+). When `Some(Ok(s))` every
    /// `chat` call returns `s`; when `Some(Err(e))` returns the error.
    /// `None` falls back to the legacy `"mock-chat-response"` string so
    /// existing R6/R7 tests keep passing.
    chat_response: Mutex<Option<Result<String, AiError>>>,
    /// When true, `chat_stream` returns `Ok(())` immediately without
    /// emitting any deltas — simulates an Ollama / OpenAI-compat
    /// provider that ignored `stream:true` and returned the full body
    /// in a non-delta shape that the SSE parser skipped. Used to test
    /// the streaming-helper's non-stream fallback.
    chat_stream_emits_no_deltas: Mutex<bool>,
    /// Optional token usage published via `set_usage_sink` so tests can
    /// exercise `AuditingProvider` + `with_token_capture` around streams.
    usage_to_write: Mutex<Option<TokenUsage>>,
    usage_slot: Mutex<Option<TokenUsageSlot>>,
    calls: Mutex<MockCalls>,
}

impl MockAIProvider {
    /// Build a mock with the given id + embedding-model id. The
    /// embedding-model id participates in the cache key — tests that
    /// want to exercise model-id invalidation pass distinct values
    /// (e.g. `"v1"` then `"v2"`).
    pub fn new(id: &str, embedding_model_id: &str) -> Self {
        Self {
            id: id.to_string(),
            embedding_model_id: embedding_model_id.to_string(),
            embeddings: Mutex::new(HashMap::new()),
            default_vector: vec![1.0, 0.0, 0.0, 0.0],
            embed_error: Mutex::new(None),
            chat_response: Mutex::new(None),
            chat_stream_emits_no_deltas: Mutex::new(false),
            usage_to_write: Mutex::new(None),
            usage_slot: Mutex::new(None),
            calls: Mutex::new(MockCalls::default()),
        }
    }

    /// Configure token counts published on the next chat / chat_stream call.
    #[allow(dead_code)]
    pub fn with_usage(self, usage: TokenUsage) -> Self {
        *self.usage_to_write.lock().unwrap() = Some(usage);
        self
    }

    fn publish_usage(&self) {
        let usage = self.usage_to_write.lock().unwrap().clone();
        if let Some(usage) = usage {
            if let Ok(guard) = self.usage_slot.lock() {
                if let Some(ref slot) = *guard {
                    if let Ok(mut g) = slot.lock() {
                        *g = Some(usage);
                    }
                }
            }
        }
    }

    /// Pin the next (and every subsequent) `chat` call to return the
    /// given string. Subsequent overrides replace the prior one.
    #[allow(dead_code)]
    pub fn with_chat_response(self, response: &str) -> Self {
        *self.chat_response.lock().unwrap() = Some(Ok(response.to_string()));
        self
    }

    /// Force the next (and every subsequent) `chat` call to return the
    /// given error.
    #[allow(dead_code)]
    pub fn fail_chat_with(&self, e: AiError) {
        *self.chat_response.lock().unwrap() = Some(Err(e));
    }

    /// Make `chat_stream` complete cleanly without emitting any token
    /// deltas — simulates a misbehaving provider. The non-streaming
    /// `chat` call still works, so callers can test fallback paths.
    #[allow(dead_code)]
    pub fn make_chat_stream_emit_no_deltas(&self) {
        *self.chat_stream_emits_no_deltas.lock().unwrap() = true;
    }

    /// Add a per-text embedding override. Vectors should already be
    /// L2-unit (the real provider L2-normalises; tests typically pass
    /// hand-crafted basis vectors).
    pub fn with_embedding(self, text: &str, vector: Vec<f32>) -> Self {
        self.embeddings
            .lock()
            .unwrap()
            .insert(text.to_string(), vector);
        self
    }

    /// Force the next (and every subsequent) `embed` call to fail.
    pub fn fail_embed_with(&self, e: AiError) {
        *self.embed_error.lock().unwrap() = Some(e);
    }

    /// Clear a previously-installed embed error so subsequent calls
    /// succeed again. Useful for "fail then recover" tests.
    #[allow(dead_code)]
    pub fn clear_embed_error(&self) {
        *self.embed_error.lock().unwrap() = None;
    }

    /// Snapshot of recorded calls.
    pub fn snapshot_calls(&self) -> MockCalls {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl AIProvider for MockAIProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        "MockAIProvider"
    }

    fn embedding_model_id(&self) -> &str {
        &self.embedding_model_id
    }

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        // Record the call BEFORE checking the error — tests that drive
        // a failure path also want to assert the call happened.
        self.calls
            .lock()
            .unwrap()
            .embed_calls
            .push(texts.iter().map(|s| s.to_string()).collect());
        // `AiError` derives `Clone` (R4) so the stored error can be
        // replayed across multiple `embed` calls without consuming it.
        if let Some(e) = self.embed_error.lock().unwrap().clone() {
            return Err(e);
        }
        let map = self.embeddings.lock().unwrap();
        let out: Vec<Vec<f32>> = texts
            .iter()
            .map(|t| {
                map.get(*t)
                    .cloned()
                    .unwrap_or_else(|| self.default_vector.clone())
            })
            .collect();
        Ok(out)
    }

    async fn embed_query(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        // Recorded into `embed_query_calls`, NOT `embed_calls` — deliberately
        // does not delegate to `self.embed(...)` (which would double-count
        // the call under `embed_calls` too), so tests can assert exactly
        // which method a query call site used.
        self.calls
            .lock()
            .unwrap()
            .embed_query_calls
            .push(texts.iter().map(|s| s.to_string()).collect());
        if let Some(e) = self.embed_error.lock().unwrap().clone() {
            return Err(e);
        }
        let map = self.embeddings.lock().unwrap();
        let out: Vec<Vec<f32>> = texts
            .iter()
            .map(|t| {
                map.get(*t)
                    .cloned()
                    .unwrap_or_else(|| self.default_vector.clone())
            })
            .collect();
        Ok(out)
    }

    fn set_usage_sink(&self, slot: TokenUsageSlot) {
        if let Ok(mut guard) = self.usage_slot.lock() {
            *guard = Some(slot);
        }
    }

    async fn chat(&self, messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
        {
            let mut calls = self.calls.lock().unwrap();
            calls.chat_calls += 1;
            calls.last_chat_messages = Some(messages.to_vec());
        }
        self.publish_usage();
        // Programmable response (with_chat_response / fail_chat_with);
        // falls back to a stable string so R6/R7 tests that don't
        // configure one keep passing.
        if let Some(prog) = self.chat_response.lock().unwrap().clone() {
            return prog;
        }
        Ok("mock-chat-response".to_string())
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        // Snapshot the current feature label so tests can verify
        // task-local propagation across the spawn boundary in
        // `stream_chat_with_fallback`.
        self.calls.lock().unwrap().last_chat_stream_feature =
            Some(crate::ai::audit::current_feature());

        // When the test asked us to simulate a misbehaving provider
        // (e.g. an Ollama model that ignores `stream:true`), complete
        // cleanly without sending any deltas. The trait default would
        // otherwise fall back to `chat()` and emit one delta — defeating
        // the purpose of the toggle.
        if *self.chat_stream_emits_no_deltas.lock().unwrap() {
            // Drop tx so receiver loop terminates; observe cancel for
            // contract-correctness.
            drop(tx);
            tokio::select! {
                _ = cancel.cancelled() => Err(AiError::Cancelled),
                _ = async {} => Ok(()),
            }
        } else {
            // Default behaviour: race chat() against cancel and emit
            // result as a single delta — same as the trait default.
            let result = tokio::select! {
                _ = cancel.cancelled() => return Err(AiError::Cancelled),
                r = self.chat(messages, opts) => r,
            };
            let content = result?;
            tokio::select! {
                _ = cancel.cancelled() => Err(AiError::Cancelled),
                send = tx.send(content) => {
                    if send.is_err() {
                        Err(AiError::Cancelled)
                    } else {
                        Ok(())
                    }
                }
            }
        }
    }

    async fn generate_image(&self, _prompt: &str, _opts: ImageOpts) -> Result<Vec<u8>, AiError> {
        self.calls.lock().unwrap().image_calls += 1;
        // Returns the PNG magic-byte signature followed by 4 padding
        // bytes. Adequate for tests that ONLY sniff the magic bytes
        // (e.g. `validate_image_bytes` in openai_compat). NOT a valid
        // standalone PNG — tests that pipe these bytes through a real
        // decoder (`image::load_from_memory`) MUST construct their own
        // 1×1 fixture instead.
        Ok(vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0,
        ])
    }
}
