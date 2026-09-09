//! `claude-cli` provider — spawns the local `claude` CLI in non-interactive
//! streaming mode and forwards `content_block_delta` text events as token
//! deltas. See `NOTES.md` for the exact event shape this parser matches.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::ai::error::AiError;
use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, Message};
use crate::ai::providers::cli::{
    prompt::build_prompt,
    runtime::{resolve_binary, spawn_jsonl},
};

pub const PROVIDER_ID: &str = "claude-cli";

/// `claude-cli` provider. Holds a chat-model alias (`sonnet` / `opus` /
/// `haiku` / full model id) and a single-permit semaphore that
/// serialises concurrent calls — Claude subscriptions enforce per-account
/// rate limits, so two simultaneous AI features racing would just trip
/// the limiter.
///
/// The `binary_path` field exists for tests so we can point the provider
/// at a stub script without monkey-patching `PATH`. Production code
/// always constructs with `new(...)` which resolves `claude` lazily.
pub struct ClaudeCliProvider {
    chat_model: String,
    concurrency: Arc<Semaphore>,
    binary_override: Option<std::path::PathBuf>,
}

impl ClaudeCliProvider {
    pub fn new(chat_model: impl Into<String>) -> Self {
        Self {
            chat_model: chat_model.into(),
            concurrency: Arc::new(Semaphore::new(1)),
            binary_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_binary(chat_model: impl Into<String>, path: std::path::PathBuf) -> Self {
        Self {
            chat_model: chat_model.into(),
            concurrency: Arc::new(Semaphore::new(1)),
            binary_override: Some(path),
        }
    }

    fn resolve_binary(&self) -> Result<std::path::PathBuf, AiError> {
        if let Some(p) = &self.binary_override {
            return Ok(p.clone());
        }
        resolve_binary("claude")
    }
}

#[async_trait]
impl AIProvider for ClaudeCliProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    fn display_name(&self) -> &str {
        "Claude (CLI)"
    }

    fn embedding_model_id(&self) -> &str {
        // Diagnostic sentinel: claude-cli has no embedding model. If
        // `embed()` is ever called by a code path that forgot to check
        // capabilities, the composed cache key in
        // `provider_namespaced_model_id` will read `"claude-cli:unsupported"`
        // rather than the footgun-y `"claude-cli:"`.
        "unsupported"
    }

    fn chat_model_id(&self) -> &str {
        &self.chat_model
    }

    fn endpoint_host(&self) -> String {
        "subprocess".into()
    }

    fn endpoint_class(&self) -> EndpointClass {
        EndpointClass::Subscription
    }

    async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        Err(AiError::ProviderUnsupported(
            "Claude CLI does not support embeddings; pair with an embedding provider like Voyage or Ollama".into(),
        ))
    }

    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError> {
        // Reuse the streaming pipeline so there's a single source of
        // truth for spawning + parsing.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
        let cancel = CancellationToken::new();
        let stream_cancel = cancel.clone();
        let messages_owned = messages.to_vec();
        let opts_clone = opts.clone();
        let provider_clone = self.clone_arc();
        let stream_fut = tokio::spawn(async move {
            provider_clone
                .chat_stream(&messages_owned, opts_clone, tx, stream_cancel)
                .await
        });
        let mut out = String::new();
        while let Some(delta) = rx.recv().await {
            out.push_str(&delta);
        }
        match stream_fut.await {
            Ok(Ok(())) => Ok(out),
            Ok(Err(e)) => Err(e),
            Err(join_err) => Err(AiError::ProviderError(format!(
                "claude-cli task join failed: {join_err}"
            ))),
        }
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<(), AiError> {
        // Serialise concurrent calls on this provider instance.
        let _permit = tokio::select! {
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            p = self.concurrency.clone().acquire_owned() => p
                .map_err(|e| AiError::ProviderError(format!("semaphore closed: {e}")))?,
        };

        let parts = build_prompt(messages);
        let binary = self.resolve_binary()?;
        let model = opts
            .model
            .clone()
            .unwrap_or_else(|| self.chat_model.clone());

        let mut cmd = Command::new(binary);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages")
            .arg("--no-session-persistence")
            .arg("--tools")
            .arg("")
            .arg("--permission-mode")
            .arg("dontAsk")
            .arg("--model")
            .arg(&model);
        if !parts.system.is_empty() {
            cmd.arg("--system-prompt").arg(&parts.system);
        }

        // Bridge channel: the synchronous JSONL event handler sends
        // text deltas here (non-async send, never blocks). A separate
        // forwarder task reads from the bridge and `await`s on the
        // trait-level bounded `tx` so backpressure is honoured.
        let (bridge_tx, mut bridge_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forwarder_cancel = cancel.clone();
        let forwarder_tx = tx.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(delta) = bridge_rx.recv().await {
                tokio::select! {
                    _ = forwarder_cancel.cancelled() => break,
                    res = forwarder_tx.send(delta) => {
                        if res.is_err() { break; }
                    }
                }
            }
        });

        // Track whether we surfaced a fatal `result` error inside the
        // event loop so the caller sees a precise message. `Arc<Mutex>`
        // because the handler closure is `FnMut + Send` and the outer
        // scope reads the value after the loop ends.
        let fatal: Arc<std::sync::Mutex<Option<AiError>>> = Arc::new(std::sync::Mutex::new(None));
        let fatal_for_handler = fatal.clone();
        let cancel_for_handler = cancel.clone();

        let stream_result = spawn_jsonl(
            cmd,
            Some(parts.body),
            move |evt: Value| -> Result<bool, AiError> {
                if cancel_for_handler.is_cancelled() {
                    return Ok(false);
                }
                let t = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match t {
                    "system" => {
                        // hook_*, init, status — all skipped.
                        Ok(true)
                    }
                    "stream_event" => {
                        let inner = match evt.get("event") {
                            Some(v) => v,
                            None => return Ok(true),
                        };
                        let inner_t = inner.get("type").and_then(|v| v.as_str()).unwrap_or("");

                        // Privacy invariant: we invoked claude with
                        // `--tools ""` which is documented to disable
                        // all built-in tools. If the CLI ever emits a
                        // `tool_use` block anyway (drift, bug, custom
                        // skill, env override), abort the stream
                        // rather than silently relaying the assistant
                        // to invoke filesystem / network operations.
                        if inner_t == "content_block_start" {
                            let block_type = inner
                                .get("content_block")
                                .and_then(|b| b.get("type"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if block_type == "tool_use"
                                || block_type == "server_tool_use"
                                || block_type == "tool_result"
                            {
                                if let Ok(mut slot) = fatal_for_handler.lock() {
                                    *slot = Some(AiError::ProviderError(format!(
                                        "Claude CLI emitted a {block_type} block despite \
                                         --tools \"\". Refusing to continue (privacy invariant)."
                                    )));
                                }
                                return Ok(false);
                            }
                        }
                        if inner_t == "content_block_delta" {
                            let delta_t = inner
                                .get("delta")
                                .and_then(|d| d.get("type"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if delta_t == "text_delta" {
                                if let Some(text) = inner
                                    .get("delta")
                                    .and_then(|d| d.get("text"))
                                    .and_then(|v| v.as_str())
                                {
                                    if !text.is_empty() {
                                        // Forward via the unbounded
                                        // bridge — `send` is non-async
                                        // and can never block, so the
                                        // sync `FnMut` handler is safe.
                                        if bridge_tx.send(text.to_string()).is_err() {
                                            // Receiver dropped — bail.
                                            return Ok(false);
                                        }
                                    }
                                }
                            }
                        }
                        Ok(true)
                    }
                    "result" => {
                        let is_error = evt
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if is_error {
                            let msg = evt
                                .get("result")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Claude CLI returned an error");
                            // Detect the auth failure shape so we can
                            // surface a clearer hint.
                            let lower = msg.to_ascii_lowercase();
                            let friendly = if lower.contains("logged in") || lower.contains("login")
                            {
                                "Claude CLI is not signed in. Run `claude /login` once in a \
                                 terminal."
                                    .to_string()
                            } else {
                                format!("Claude CLI: {msg}")
                            };
                            if let Ok(mut slot) = fatal_for_handler.lock() {
                                *slot = Some(AiError::ProviderError(friendly));
                            }
                        }
                        // result is always the terminal event — stop.
                        Ok(false)
                    }
                    _ => Ok(true), // assistant snapshots, rate_limit_event, etc.
                }
            },
            cancel,
        )
        .await;

        // Drop the bridge sender (the inner handler closure already
        // owns the only clone via move) and wait for the forwarder to
        // drain. The forwarder closes the trait-level `tx` when it
        // exits, so the caller in `chat` sees EOF on its receiver.
        let _ = forwarder.await;
        drop(tx);

        if let Some(e) = fatal.lock().ok().and_then(|mut g| g.take()) {
            return Err(e);
        }
        stream_result
    }
}

impl ClaudeCliProvider {
    /// Allow `chat` to delegate to `chat_stream` without re-implementing
    /// the spawn pipeline. Returns an `Arc<Self>` for use inside the
    /// spawn-task closure.
    fn clone_arc(&self) -> Arc<Self> {
        Arc::new(Self {
            chat_model: self.chat_model.clone(),
            concurrency: self.concurrency.clone(),
            binary_override: self.binary_override.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::MessageRole;
    use std::io::Write;

    fn msg(role: MessageRole, content: &str) -> Message {
        Message {
            role,
            content: content.to_string(),
        }
    }

    #[tokio::test]
    async fn embed_returns_unsupported() {
        let p = ClaudeCliProvider::new("sonnet");
        let err = p.embed(&["hello"]).await.expect_err("must Err");
        assert!(matches!(err, AiError::ProviderUnsupported(_)));
    }

    #[test]
    fn provider_metadata() {
        let p = ClaudeCliProvider::new("opus");
        assert_eq!(p.id(), "claude-cli");
        assert_eq!(p.display_name(), "Claude (CLI)");
        assert_eq!(p.chat_model_id(), "opus");
        // Diagnostic sentinel — see embedding_model_id docstring.
        assert_eq!(p.embedding_model_id(), "unsupported");
    }

    /// Build a temporary `claude`-replacement script that emits a canned
    /// stream-json sequence on stdout and exits cleanly.
    fn write_stub_script(tmp_dir: &tempfile::TempDir, stdout_lines: &[&str]) -> std::path::PathBuf {
        let path = tmp_dir.path().join("claude-stub");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "#!/bin/bash").unwrap();
        for line in stdout_lines {
            // Escape single quotes for safe heredoc-less emit.
            writeln!(f, "echo {}", shell_escape(line)).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn shell_escape(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    #[tokio::test]
    async fn chat_aggregates_text_deltas() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub_script(
            &tmp,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}"#,
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}"#,
                r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"hello world"}"#,
            ],
        );
        let p = ClaudeCliProvider::with_binary("sonnet", stub);
        let out = p
            .chat(&[msg(MessageRole::User, "say hi")], ChatOpts::default())
            .await
            .expect("must succeed");
        assert_eq!(out, "hello world");
    }

    #[tokio::test]
    async fn chat_surfaces_auth_failure_with_friendly_message() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub_script(
            &tmp,
            &[
                r#"{"type":"system","subtype":"init"}"#,
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
            ],
        );
        let p = ClaudeCliProvider::with_binary("sonnet", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("not signed in"), "msg was: {m}");
                assert!(m.contains("/login"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_skips_hook_events_silently() {
        // Real claude streams emit a flurry of hook_started/hook_response
        // events before any text. They must NOT crash the parser and
        // must NOT leak into the output.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub_script(
            &tmp,
            &[
                r#"{"type":"system","subtype":"hook_started","hook_id":"a"}"#,
                r#"{"type":"system","subtype":"hook_response","hook_id":"a","stdout":""}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"ok"}"#,
            ],
        );
        let p = ClaudeCliProvider::with_binary("sonnet", stub);
        let out = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(out, "ok");
    }

    #[tokio::test]
    async fn chat_aborts_when_cli_emits_tool_use_block() {
        // Privacy invariant: even though we pass `--tools ""`, a future
        // CLI version / regression could surface a tool_use anyway.
        // Provider must refuse to continue, not silently relay it.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub_script(
            &tmp,
            &[
                r#"{"type":"system","subtype":"init"}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":""}"#,
            ],
        );
        let p = ClaudeCliProvider::with_binary("sonnet", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err on tool_use");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("tool_use"), "msg was: {m}");
                assert!(m.contains("privacy"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_aborts_when_cli_emits_server_tool_use_block() {
        // Same invariant for the `server_tool_use` block (web_search /
        // web_fetch), which the stream-json schema treats as a peer of
        // `tool_use` rather than a sub-type.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_stub_script(
            &tmp,
            &[
                r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"server_tool_use","name":"WebSearch"}}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":""}"#,
            ],
        );
        let p = ClaudeCliProvider::with_binary("sonnet", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err on server_tool_use");
        assert!(matches!(err, AiError::ProviderError(m) if m.contains("server_tool_use")));
    }

    /// Smoke test against the real `claude` binary. Opt in with
    /// `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_claude_subprocess_smoke() {
        let p = ClaudeCliProvider::new("sonnet");
        let out = p
            .chat(
                &[msg(MessageRole::User, "say 'pong' and nothing else")],
                ChatOpts::default(),
            )
            .await
            .expect("real claude call must succeed (run `claude /login` if it fails)");
        assert!(!out.trim().is_empty(), "got empty reply");
    }
}
