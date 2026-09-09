//! On-device **LLM** chat provider — routes `chat` through the `llama-server`
//! sidecar via the existing [`OpenAICompatibleProvider`].
//!
//! This is the `AIProvider` impl that fronts the localhost llama-server
//! sidecar owned by [`LlamaServerManager`]. Generation happens entirely on the
//! loopback HTTP boundary (`http://127.0.0.1:{port}/v1`); this provider owns
//! no inference of its own — it spawns the sidecar on first chat (via
//! `ensure_running`), lazily builds an `OpenAICompatibleProvider` against the
//! returned port, delegates the chat, and marks the sidecar just-used
//! (`touch()`) so the idle-watcher keeps it alive while the user is chatting.
//!
//! Embedding is **unsupported** here — on-device embeddings live in
//! [`super::on_device_embed`] against a separate `fastembed` runtime. Pair
//! this provider with the embedding-only on-device provider (or any hosted
//! embedder) for a fully on-device chat+embed setup.
//!
//! # Error codes
//!
//! `ensure_running` returns short stable codes (`"model_not_found"`,
//! `"model_not_downloaded"`, `"start_timeout"`, `"start_failed"`). There is no
//! dedicated `AiError::OnDeviceLlmStartFailed` variant, so a start failure is
//! surfaced as [`AiError::ProviderError`] whose string carries the stable code
//! `on_device_llm_start_failed` (e.g.
//! `"on_device_llm_start_failed: start_timeout; stderr: ..."`). The frontend
//! can pattern-match on that leading code for precise messaging.

use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;

use crate::ai::audit::TokenUsageSlot;
use crate::ai::error::AiError;
use crate::ai::on_device::llm_catalog;
use crate::ai::on_device::llm_download::{HttpLlmFetcher, LlmAssetManager};
use crate::ai::on_device::server::LlamaServerManager;
use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, Message};
use crate::ai::providers::openai_compat::{OpenAICompatibleConfig, OpenAICompatibleProvider};

/// Provider id — the prefix in `provider_namespaced_chat_model_id`, so the
/// chat cache namespace is `"on-device-llm:<catalog model id>"`.
pub const PROVIDER_ID: &str = "on-device-llm";

/// Stable error-code prefix embedded in the `ProviderError` string when
/// `ensure_running` fails. Frontends can string-match this for precise UX
/// ("Starting the on-device model failed — retry / show download progress")
/// rather than the generic "provider unreachable" copy that `ProviderError`
/// usually maps to.
pub const START_FAILED_CODE: &str = "on_device_llm_start_failed";

/// `AIProvider` impl fronting the on-device `llama-server` sidecar.
///
/// Holds a lazily-built inner [`OpenAICompatibleProvider`] keyed by the
/// sidecar's port. The port can change across a respawn (model switch, idle
/// stop + restart on a new OS-assigned port), so the cached inner is rebuilt
/// whenever the live port differs from the cached one.
pub struct OnDeviceLlmProvider {
    server: Arc<LlamaServerManager>,
    assets: Arc<LlmAssetManager>,
    /// Catalog id (e.g. `"gemma-4-e4b-it"`). Used as the chat model id so the
    /// cache key becomes `on-device-llm:<catalog id>`.
    model_id: String,
    /// Cached display name from the catalog entry. Resolved once at
    /// construction (the ctor rejects unknown ids) so `display_name()` is a
    /// cheap `&str` accessor with no catalog lookup per call.
    display_name: String,
    /// Lazily-built inner provider, keyed by port. Rebuilt when the port
    /// changes (respawn on a new OS-assigned port). `tokio::sync::RwLock`
    /// because the read hold (delegate the chat) outlasts `.await` — a std
    /// `RwLock` guard held across `.await` would not be `Send`.
    inner: tokio::sync::RwLock<Option<(u16, OpenAICompatibleProvider)>>,
    /// Stored `TokenUsageSlot` registered via `set_usage_sink` BEFORE the
    /// inner provider was first built. Cloned into each fresh inner when it
    /// is constructed so a slot registered before the first chat still
    /// receives token counts. `std::sync::Mutex` (only held for an instant
    /// clone-take, never across `.await`).
    usage_sink: StdMutex<Option<TokenUsageSlot>>,
}

impl OnDeviceLlmProvider {
    /// Build a new on-device LLM provider for `model_id`.
    ///
    /// Looks up the catalog entry up front so an unknown id fails fast at
    /// construction (the command layer builds one provider per settings
    /// change). The sidecar is NOT spawned here — first chat does that
    /// lazily via [`LlamaServerManager::ensure_running`].
    pub fn new(
        server: Arc<LlamaServerManager>,
        assets: Arc<LlmAssetManager>,
        model_id: String,
    ) -> Result<Self, AiError> {
        let model = llm_catalog::find(&model_id).ok_or_else(|| {
            AiError::ProviderError(format!("unknown on-device-llm model: {model_id}"))
        })?;
        Ok(Self {
            server,
            assets,
            display_name: model.display_name.to_string(),
            model_id,
            inner: tokio::sync::RwLock::new(None),
            usage_sink: StdMutex::new(None),
        })
    }

    /// Fetch the inner provider for `port`, building (or rebuilding) it if
    /// the cached inner is for a different port (or not built yet). Returns
    /// the port + a guard over the live inner.
    ///
    /// The rebuild-on-port-change matters because the sidecar's port is
    /// OS-assigned per spawn: after a model switch or an idle stop, the next
    /// `ensure_running` binds a fresh port, and the cached inner pointing at
    /// the old port would 4xx/timeout.
    async fn get_or_build_inner(&self, port: u16) -> Result<InnerGuard<'_>, AiError> {
        // Fast path under a read lock: cached inner for the SAME port.
        {
            let read = self.inner.read().await;
            if let Some((p, _)) = read.as_ref() {
                if *p == port {
                    return Ok(InnerGuard::Read(read));
                }
            }
        }
        // Slow path: port changed (or first build). Take a write lock,
        // re-check (another concurrent caller may have rebuilt already),
        // then construct a fresh inner.
        let mut write = self.inner.write().await;
        if let Some((p, _)) = write.as_ref() {
            if *p == port {
                // Another caller rebuilt while we waited for the write lock.
                return Ok(InnerGuard::Write(write));
            }
        }
        let stored_sink = self.usage_sink.lock().unwrap().clone();
        let cfg = OpenAICompatibleConfig {
            id: PROVIDER_ID.into(),
            display_name: self.display_name.clone(),
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            // llama-server runs unauthenticated on the loopback — no bearer.
            api_key: None,
            chat_model: self.model_id.clone(),
            // This provider never embeds; the inner's embedding_model is
            // irrelevant (embed() short-circuits before delegating).
            embedding_model: String::new(),
            image_model: None,
        };
        let provider = OpenAICompatibleProvider::new(cfg)?;
        // Forward a registered usage sink so token counts from this inner
        // reach the AuditingProvider wrapping us even though the inner was
        // built AFTER set_usage_sink was called.
        if let Some(slot) = stored_sink {
            provider.set_usage_sink(slot);
        }
        *write = Some((port, provider));
        Ok(InnerGuard::Write(write))
    }

    /// Pure delegation helper: build/reuse the inner provider against `port`
    /// and delegate a chat call. Splits the "delegate to the OpenAI-compat
    /// inner against a known port" concern from the "resolve the sidecar
    /// port via ensure_running" concern so the delegation path is testable
    /// against a local stub HTTP server without spawning a real sidecar.
    ///
    /// Does NOT call `touch()` — that's the caller's job (`chat`/`chat_stream`
    /// do it after this resolves). Kept this way so a unit test of the
    /// delegation can't accidentally perturb the idle timer.
    async fn chat_via(
        &self,
        port: u16,
        messages: &[Message],
        opts: ChatOpts,
    ) -> Result<String, AiError> {
        let guard = self.get_or_build_inner(port).await?;
        let provider = guard.provider();
        provider.chat(messages, opts).await
    }

    /// Streaming variant of [`Self::chat_via`] — same port-keyed build/reuse
    /// and delegation, against `chat_stream`.
    async fn chat_stream_via(
        &self,
        port: u16,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        let guard = self.get_or_build_inner(port).await?;
        let provider = guard.provider();
        provider.chat_stream(messages, opts, tx, cancel).await
    }

    /// Ensure the `llama-server` sidecar BINARY is installed before spawning.
    ///
    /// The binary is normally fetched as part of a model download
    /// (`download_on_device_llm_model` runs `ensure_server_binary` first), but
    /// it can legitimately be MISSING while a model is present: after a
    /// `SERVER_VERSION_TAG` bump the new `bin/<tag>/` dir starts empty, or the
    /// binary dir was cleared. Without this guard, `ensure_running` would try
    /// to spawn a nonexistent path and fail with a cryptic
    /// `No such file or directory (os error 2)`. Idempotent — a cheap no-op
    /// (`is_binary_installed`) once the binary is present.
    async fn ensure_binary(&self) -> Result<(), AiError> {
        if self.assets.is_binary_installed() {
            return Ok(());
        }
        // Build a streaming reqwest client (mirrors the download command). The
        // binary is ~11 MB, so this JIT fetch adds only a short one-time pause
        // on the first chat after a fresh install / version bump.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| {
                AiError::ProviderError(format!("{START_FAILED_CODE}: client_build: {e}"))
            })?;
        let fetcher = HttpLlmFetcher::new(client);
        let cancel = tokio_util::sync::CancellationToken::new();
        self.assets
            .ensure_server_binary(&fetcher, &cancel)
            .await
            .map_err(|code| AiError::ProviderError(format!("{START_FAILED_CODE}: {code}")))?;
        Ok(())
    }
}

/// Either a read or write lock guard over the cached inner provider. Both
/// expose an immutable borrow of the live `OpenAICompatibleProvider`; the
/// enum exists because the fast path takes a read lock and the rebuild path
/// takes a write lock, but the caller only needs to read.
enum InnerGuard<'a> {
    Read(tokio::sync::RwLockReadGuard<'a, Option<(u16, OpenAICompatibleProvider)>>),
    Write(tokio::sync::RwLockWriteGuard<'a, Option<(u16, OpenAICompatibleProvider)>>),
}

impl<'a> InnerGuard<'a> {
    fn provider(&self) -> &OpenAICompatibleProvider {
        let opt_ref: &Option<(u16, OpenAICompatibleProvider)> = match self {
            InnerGuard::Read(g) => g,
            InnerGuard::Write(g) => g,
        };
        &opt_ref
            .as_ref()
            .expect("inner populated before returning a guard")
            .1
    }
}

#[async_trait]
impl AIProvider for OnDeviceLlmProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn embedding_model_id(&self) -> &str {
        // This provider never embeds; the id is irrelevant. Empty string so
        // a stray compose (`on-device-llm:`) is obviously wrong rather than
        // masquerading as a real embedding model.
        ""
    }

    fn chat_model_id(&self) -> &str {
        &self.model_id
    }

    fn endpoint_host(&self) -> String {
        // llama-server binds 127.0.0.1 — loopback, never remote.
        "127.0.0.1".to_string()
    }

    fn endpoint_class(&self) -> EndpointClass {
        // OnDevice (not Local) so audit logs / UI copy can distinguish
        // "in-process sidecar on this machine" from "your own HTTP endpoint".
        EndpointClass::OnDevice
    }

    fn set_usage_sink(&self, slot: TokenUsageSlot) {
        // Store the slot on self so the NEXT build of the inner forwards it.
        // `AuditingProvider` wraps this provider once, before any chat fires,
        // so the inner is `None` here on first registration — the build path
        // (`get_or_build_inner`) clones the stored slot into each fresh
        // inner, including rebuilds after a port change. There is no sync
        // way to read a `tokio::sync::RwLock`, so we don't try to forward to
        // an already-built inner; that's fine because the only legitimate
        // caller registers before the first chat.
        if let Ok(mut stored) = self.usage_sink.lock() {
            *stored = Some(slot);
        }
    }

    async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        Err(AiError::ProviderUnsupported(
            "on-device-llm does not embed; pair it with the on-device embedding provider".into(),
        ))
    }

    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError> {
        // Download the sidecar binary JIT if it's missing (fresh install /
        // version bump) BEFORE trying to spawn it.
        self.ensure_binary().await?;
        let port = self
            .server
            .ensure_running(&self.model_id, &self.assets)
            .await
            .map_err(|e| AiError::ProviderError(format!("{START_FAILED_CODE}: {e}")))?;
        let result = self.chat_via(port, messages, opts).await;
        // Mark the sidecar just-used AFTER the request resolves, on both Ok
        // and Err — a failed request still counts as activity (the user is
        // interacting; stopping mid-error would feel broken). Done before
        // returning so the idle timer sees activity even if the caller drops
        // the result.
        self.server.touch();
        result
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        self.ensure_binary().await?;
        let port = self
            .server
            .ensure_running(&self.model_id, &self.assets)
            .await
            .map_err(|e| AiError::ProviderError(format!("{START_FAILED_CODE}: {e}")))?;
        let result = self.chat_stream_via(port, messages, opts, tx, cancel).await;
        self.server.touch();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::on_device::llm_catalog::GEMMA_4_E4B_IT;
    use crate::ai::on_device::server::{LlamaServerManager, ServerChild, ServerRuntime};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ─── Test approach ───────────────────────────────────────────────────────
    //
    // (c) split-helper + (b) end-to-end. The pure delegation path is tested
    // via `chat_via(port)` against a local stub HTTP server (no manager
    // involved); the full ensure_running → delegate → touch path is tested
    // via a `FakeServerRuntime` whose `spawn` binds a REAL TCP server serving
    // a canned OpenAI chat-completion JSON on the exact port `pick_port`
    // returned. The `ensure_running` error path uses a `FakeServerRuntime`
    // that serves no health endpoint, so `wait_ready` times out and
    // `ensure_running` returns `Err("start_timeout")` → mapped to
    // ProviderError containing the start-failed code.

    /// Build an `OnDeviceLlmProvider` against a manager backed by `runtime`
    /// + a tempdir `LlmAssetManager` with the test model pre-stamped as
    /// downloaded. Returns the provider AND the `Arc<LlamaServerManager>`
    /// (for `last_used_elapsed` assertions) AND the tempdir (so it stays
    /// alive for the test duration).
    fn provider_with(
        runtime: Arc<dyn ServerRuntime>,
    ) -> (
        OnDeviceLlmProvider,
        Arc<LlamaServerManager>,
        Arc<LlmAssetManager>,
        tempfile::TempDir,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));
        let dir = assets.model_dir(GEMMA_4_E4B_IT);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(assets.model_gguf_path(GEMMA_4_E4B_IT), b"dummy gguf").unwrap();
        std::fs::write(dir.join(".llm_ready"), b"1").unwrap();
        // Install a dummy binary so `chat()`'s `ensure_binary()` guard is a
        // no-op (short-circuits on `is_binary_installed`) instead of trying to
        // fetch the real ~11 MB sidecar over the network — these tests must
        // stay offline + deterministic.
        let binary_path = assets.binary_path();
        std::fs::create_dir_all(binary_path.parent().unwrap()).unwrap();
        std::fs::write(&binary_path, b"#!/bin/sh\n").unwrap();
        let server = Arc::new(LlamaServerManager::new_with_runtime(
            runtime,
            // Idle timeout is irrelevant for these tests (we assert on
            // last_used_elapsed directly); 50ms keeps any stray watcher
            // fast if it ever runs.
            Duration::from_millis(50),
        ));
        let provider =
            OnDeviceLlmProvider::new(server.clone(), assets.clone(), GEMMA_4_E4B_IT.into())
                .expect("ctor must succeed for a known model id");
        (provider, server, assets, tmp)
    }

    /// Canned OpenAI chat-completion JSON the stub server returns for every
    /// request, regardless of path/body. The assistant content carries a
    /// unique marker so a test can confirm the body actually came from the
    /// specific server it pointed at (useful for the port-change rebuild
    /// test).
    fn chat_completion_body(content: &str) -> Vec<u8> {
        let json = format!(
            "{{\"choices\":[{{\"message\":{{\"role\":\"assistant\",\"content\":{}}}}}]}}",
            serde_json::Value::String(content.to_string())
        );
        json.into_bytes()
    }

    /// Bind a real loopback TCP server on an OS-assigned port that responds
    /// to every request with `body` as JSON. Returns the port. The accept
    /// loop runs for as long as the test holds the runtime (the spawned
    /// tasks die with the runtime / test).
    async fn spawn_canned_server(content: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = chat_completion_body(content);
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let body = body.clone();
                tokio::spawn(async move {
                    // Drain the request line + headers (up to \r\n\r\n).
                    let mut buf = [0u8; 1024];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });
        port
    }

    /// Build a `FakeServerRuntime` whose `pick_port` returns a fixed port
    /// AND whose `spawn` binds a real canned-response HTTP server on exactly
    /// that port — so production `wait_ready` succeeds and the provider's
    /// delegated chat call lands on our canned response. `content` is the
    /// assistant content the canned server returns.
    fn runtime_serving_canned(content: &'static str) -> Arc<ChatFakeRuntime> {
        Arc::new(ChatFakeRuntime::new(content))
    }

    /// `FakeServerRuntime` variant that binds a canned-response HTTP server
    /// on the port `pick_port` returned, so the provider's full
    /// ensure_running → OpenAI-compat chat path lands on a deterministic
    /// response.
    struct ChatFakeRuntime {
        content: &'static str,
        spawn_count: AtomicU32,
        kill_count: AtomicU32,
        /// The OS-assigned port handed out by `pick_port`; consumed by
        /// `spawn` to bind the canned-response server. Stored behind a mutex
        /// so `spawn` can read it.
        port: StdMutex<Option<u16>>,
        listener: StdMutex<Option<TcpListener>>,
    }

    impl ChatFakeRuntime {
        fn new(content: &'static str) -> Self {
            Self {
                content,
                spawn_count: AtomicU32::new(0),
                kill_count: AtomicU32::new(0),
                port: StdMutex::new(None),
                listener: StdMutex::new(None),
            }
        }
    }

    #[async_trait]
    impl ServerRuntime for ChatFakeRuntime {
        async fn pick_port(&self) -> Result<u16, String> {
            // Bind a real listener so the port is unique to this runtime and
            // the provider's OpenAI-compat client can connect to it. Hand
            // the listener to `spawn` to actually serve.
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| format!("fake pick_port bind failed: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("fake pick_port local_addr failed: {e}"))?
                .port();
            *self.port.lock().unwrap() = Some(port);
            *self.listener.lock().unwrap() = Some(listener);
            Ok(port)
        }

        async fn spawn(
            &self,
            _binary_path: &std::path::Path,
            _model_path: &std::path::Path,
            _port: u16,
            _ctx_size: u32,
        ) -> Result<ServerChild, String> {
            self.spawn_count.fetch_add(1, Ordering::SeqCst);
            // Take the listener bound in pick_port and serve the canned chat
            // completion on it. This is what makes the provider's delegated
            // chat call land on a deterministic response.
            if let Some(listener) = self.listener.lock().unwrap().take() {
                let content = self.content;
                serve_chat_on(listener, content);
            }
            Ok(ServerChild { pid: Some(42000) })
        }

        async fn wait_ready(&self, _port: u16, _timeout: Duration) -> Result<(), String> {
            // Health-check passes immediately — the canned server is up.
            Ok(())
        }

        async fn kill_child(&self, _child: &ServerChild) -> Result<(), String> {
            self.kill_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn kill_all(&self) -> Result<(), String> {
            self.kill_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn kill_sync(&self) {
            self.kill_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Take a bound `TcpListener` and serve the canned chat-completion JSON
    /// for `content` on every connection until the test ends.
    fn serve_chat_on(listener: TcpListener, content: &'static str) {
        tokio::spawn(async move {
            let body = chat_completion_body(content);
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });
    }

    // ─── 1. trait method values ─────────────────────────────────────────────

    #[tokio::test]
    async fn trait_methods_return_expected_values() {
        let rt: Arc<dyn ServerRuntime> = Arc::new(ChatFakeRuntime::new("ok"));
        let (p, _server, _assets, _tmp) = provider_with(rt);
        assert_eq!(p.id(), "on-device-llm");
        assert_eq!(p.chat_model_id(), GEMMA_4_E4B_IT);
        assert_eq!(p.endpoint_class(), EndpointClass::OnDevice);
        assert_eq!(p.endpoint_host(), "127.0.0.1");
        // display_name comes from the catalog entry.
        assert_eq!(p.display_name(), "Gemma 4 E4B (QAT Q4_0)");
    }

    // ─── 2. embed rejects ───────────────────────────────────────────────────

    #[tokio::test]
    async fn embed_returns_provider_unsupported() {
        let rt: Arc<dyn ServerRuntime> = Arc::new(ChatFakeRuntime::new("ok"));
        let (p, _server, _assets, _tmp) = provider_with(rt);
        let err = p.embed(&["hello"]).await.unwrap_err();
        assert!(
            matches!(err, AiError::ProviderUnsupported(_)),
            "got {err:?}"
        );
    }

    // ─── 3. ctor rejects unknown model id ───────────────────────────────────

    #[tokio::test]
    async fn ctor_rejects_unknown_model_id_with_provider_error() {
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));
        let server = Arc::new(LlamaServerManager::new_with_runtime(
            Arc::new(ChatFakeRuntime::new("ok")),
            Duration::from_millis(50),
        ));
        let result = OnDeviceLlmProvider::new(server, assets, "does-not-exist".into());
        match result {
            Err(AiError::ProviderError(s)) => {
                assert!(s.contains("unknown on-device-llm model"), "got {s}")
            }
            Err(other) => panic!("expected ProviderError, got {other:?}"),
            Ok(_) => panic!("ctor must reject unknown model id"),
        }
    }

    // ─── 4. chat delegates to the inner provider + touches last_used ────────
    //
    // End-to-end: ensure_running spawns the fake runtime (which binds a real
    // canned-response HTTP server), the delegated chat lands on the canned
    // response, AND `server.touch()` was called after the request.

    #[tokio::test]
    async fn chat_delegates_and_touches_last_used() {
        let rt = runtime_serving_canned("from-sidecar");
        let (p, server, _assets, _tmp) = provider_with(rt.clone());

        // Bump last_used_elapsed so the post-chat touch() delta is observable.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let before = server.last_used_elapsed();
        assert!(before >= Duration::from_millis(20));

        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let out = p
            .chat(&msgs, ChatOpts::default())
            .await
            .expect("chat must succeed");
        assert_eq!(out, "from-sidecar");
        assert_eq!(
            rt.spawn_count.load(Ordering::SeqCst),
            1,
            "sidecar spawned once"
        );

        // touch() must have reset last_used — elapsed now small.
        let after = server.last_used_elapsed();
        assert!(
            after < before,
            "touch() did not reset last_used: before={before:?} after={after:?}"
        );
    }

    // ─── 4b. chat_via delegates against an arbitrary stub port (split-helper) ──
    //
    // Pure delegation, no manager: confirms the OpenAI-compat inner is built
    // against the given port and the canned response comes back.

    #[tokio::test]
    async fn chat_via_delegates_against_stub_http_server() {
        let rt: Arc<dyn ServerRuntime> = Arc::new(ChatFakeRuntime::new("unused"));
        let (p, _server, _assets, _tmp) = provider_with(rt);
        // Bind a standalone stub server (not via the runtime) and chat
        // through chat_via at its port — no ensure_running involved.
        let port = spawn_canned_server("via-helper").await;
        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let out = p
            .chat_via(port, &msgs, ChatOpts::default())
            .await
            .expect("chat_via must delegate");
        assert_eq!(out, "via-helper");
    }

    // ─── 5. port change rebuilds the inner ──────────────────────────────────
    //
    // Two chat_via calls at two different ports (two stub servers) must BOTH
    // succeed and each return the body from its own server — proving the
    // inner was rebuilt for the new port rather than reusing the old one.

    #[tokio::test]
    async fn port_change_rebuilds_inner() {
        let rt: Arc<dyn ServerRuntime> = Arc::new(ChatFakeRuntime::new("unused"));
        let (p, _server, _assets, _tmp) = provider_with(rt);
        let port_a = spawn_canned_server("port-a").await;
        let port_b = spawn_canned_server("port-b").await;
        assert_ne!(port_a, port_b, "test setup: ports must differ");

        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let a = p
            .chat_via(port_a, &msgs, ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(a, "port-a");
        // Re-challenge port_a to confirm caching on the SAME port works
        // (no rebuild needed) — the inner is reused.
        let a2 = p
            .chat_via(port_a, &msgs, ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(a2, "port-a");
        // Now a DIFFERENT port — inner must rebuild and the new server's
        // body comes back.
        let b = p
            .chat_via(port_b, &msgs, ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(b, "port-b");
        // And going back to port_a still works (rebuild again).
        let a3 = p
            .chat_via(port_a, &msgs, ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(a3, "port-a");
    }

    // ─── 5b. inner RwLock stored port changes after rebuild ──────────────────
    //
    // Observable internal proof that the cached inner's port moved: read the
    // `inner` RwLock directly after two chat_via calls at different ports.

    #[tokio::test]
    async fn inner_cached_port_tracks_last_used_port() {
        let rt: Arc<dyn ServerRuntime> = Arc::new(ChatFakeRuntime::new("unused"));
        let (p, _server, _assets, _tmp) = provider_with(rt);
        let port_a = spawn_canned_server("a").await;
        let port_b = spawn_canned_server("b").await;

        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let _ = p
            .chat_via(port_a, &msgs, ChatOpts::default())
            .await
            .unwrap();
        {
            let read = p.inner.read().await;
            assert_eq!(read.as_ref().unwrap().0, port_a, "inner cached port_a");
        }
        let _ = p
            .chat_via(port_b, &msgs, ChatOpts::default())
            .await
            .unwrap();
        {
            let read = p.inner.read().await;
            assert_eq!(read.as_ref().unwrap().0, port_b, "inner rebuilt to port_b");
        }
    }

    // ─── 6. ensure_running error propagates as ProviderError with the code ────
    //
    // A runtime whose `wait_ready` times out (no health server) makes
    // `ensure_running` return Err — `chat` must map that to ProviderError
    // containing `on_device_llm_start_failed`.

    /// `FakeServerRuntime` that never serves health → `wait_ready` fails →
    /// `ensure_running` returns `Err("start_timeout")`.
    struct NoHealthRuntime;

    #[async_trait]
    impl ServerRuntime for NoHealthRuntime {
        async fn pick_port(&self) -> Result<u16, String> {
            // Real free port (then dropped) — nothing binds it, so the
            // provider's chat call would also fail, but `ensure_running`
            // short-circuits at `wait_ready` before that.
            crate::ai::on_device::server::pick_free_port().await
        }
        async fn spawn(
            &self,
            _binary_path: &std::path::Path,
            _model_path: &std::path::Path,
            _port: u16,
            _ctx_size: u32,
        ) -> Result<ServerChild, String> {
            Ok(ServerChild { pid: Some(99999) })
        }
        async fn wait_ready(&self, _port: u16, _timeout: Duration) -> Result<(), String> {
            Err("no health server (test-injected timeout)".to_string())
        }
        async fn kill_child(&self, _child: &ServerChild) -> Result<(), String> {
            Ok(())
        }
        async fn kill_all(&self) -> Result<(), String> {
            Ok(())
        }
        fn kill_sync(&self) {}
    }

    #[tokio::test]
    async fn chat_maps_ensure_running_error_to_provider_error_with_code() {
        // Use a manager with a tiny startup_timeout so the leader's
        // wait_ready budget is tiny (the fake fails fast regardless, but the
        // tiny budget keeps the test snappy).
        let server = Arc::new(LlamaServerManager::new_with_runtime_and_startup(
            Arc::new(NoHealthRuntime),
            Duration::from_millis(50),
            Duration::from_millis(50),
            Duration::from_millis(50),
        ));
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));
        let dir = assets.model_dir(GEMMA_4_E4B_IT);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(assets.model_gguf_path(GEMMA_4_E4B_IT), b"dummy").unwrap();
        std::fs::write(dir.join(".llm_ready"), b"1").unwrap();

        let p = OnDeviceLlmProvider::new(server, assets, GEMMA_4_E4B_IT.into()).unwrap();
        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let err = p.chat(&msgs, ChatOpts::default()).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(
                s.contains(START_FAILED_CODE),
                "expected ProviderError containing {START_FAILED_CODE}, got: {s}"
            ),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    // ─── bonus: set_usage_sink forwards to inner on build ────────────────────
    //
    // Register a usage sink BEFORE the first chat (AuditingProvider wraps
    // before any chat fires); after a chat, the inner must have written the
    // canned token counts. The canned server above does NOT emit a `usage`
    // field, so this asserts the sink was forwarded (no panic) and stays
    // `None` (no usage reported) — a minimal contract that the wiring does
    // not crash. A future test could serve a `usage` payload and assert the
    // counts propagated.

    #[tokio::test]
    async fn set_usage_sink_is_forwarded_to_inner_on_build() {
        // Register a usage sink BEFORE the first chat (AuditingProvider wraps
        // before any chat fires). The canned server omits the `usage` field,
        // so the inner's `write_usage` writes `Some(TokenUsage{None,None})`.
        // The fact that the slot transitions from `None` to `Some` at all is
        // the proof the sink was forwarded to the freshly-built inner —
        // without forwarding, `write_usage` would no-op on the inner's own
        // (un-registered) sink and the slot would stay `None`.
        let rt = runtime_serving_canned("ok");
        let (p, _server, _assets, _tmp) = provider_with(rt);
        let slot: TokenUsageSlot = Arc::new(std::sync::Mutex::new(None));
        p.set_usage_sink(slot.clone());

        let msgs = vec![Message {
            role: crate::ai::provider::MessageRole::User,
            content: "hi".into(),
        }];
        let _ = p.chat(&msgs, ChatOpts::default()).await.unwrap();
        let usage = slot.lock().unwrap().clone();
        let usage =
            usage.expect("slot was never written — set_usage_sink was not forwarded to the inner");
        // Canned server omits `usage`, so both counts are None.
        assert!(usage.tokens_in.is_none());
        assert!(usage.tokens_out.is_none());
    }
}
