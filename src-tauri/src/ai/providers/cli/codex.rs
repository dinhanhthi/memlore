//! `codex-cli` provider — spawns the local `codex exec --json` and forwards
//! the agent's final reply as a single delta. Codex 0.122 does NOT emit
//! token-level deltas via `--json` (only a single `item.completed` with
//! `item.type == "agent_message"`), so streaming is degraded to "wait,
//! then receive whole answer". The `--output-last-message <file>` flag
//! is wired as a fallback path: if no `agent_message` event ever
//! arrives (error mid-turn, schema drift), we still surface whatever
//! text Codex managed to write to the tmp file.
//!
//! See `NOTES.md` for the full event shape and the flag quirks
//! (`-c approval_policy=never`, stdin must be closed, default model
//! `gpt-5.5` is unavailable to ChatGPT-account users — pass `--model`
//! explicitly).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::ai::error::AiError;
use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, Message};
use crate::ai::providers::cli::{
    prompt::{build_prompt, fold_system_into_body},
    runtime::{resolve_binary, spawn_jsonl},
};

pub const PROVIDER_ID: &str = "codex-cli";

/// `codex-cli` provider. Holds a chat-model id (e.g. `gpt-5.4`) and a
/// single-permit semaphore that serialises concurrent calls — ChatGPT
/// subscriptions enforce per-account rate limits.
pub struct CodexCliProvider {
    chat_model: String,
    concurrency: Arc<Semaphore>,
    binary_override: Option<PathBuf>,
}

impl CodexCliProvider {
    pub fn new(chat_model: impl Into<String>) -> Self {
        Self {
            chat_model: chat_model.into(),
            concurrency: Arc::new(Semaphore::new(1)),
            binary_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_binary(chat_model: impl Into<String>, path: PathBuf) -> Self {
        Self {
            chat_model: chat_model.into(),
            concurrency: Arc::new(Semaphore::new(1)),
            binary_override: Some(path),
        }
    }

    fn resolve_binary(&self) -> Result<PathBuf, AiError> {
        if let Some(p) = &self.binary_override {
            return Ok(p.clone());
        }
        resolve_binary("codex")
    }

    fn clone_arc(&self) -> Arc<Self> {
        Arc::new(Self {
            chat_model: self.chat_model.clone(),
            concurrency: self.concurrency.clone(),
            binary_override: self.binary_override.clone(),
        })
    }
}

#[async_trait]
impl AIProvider for CodexCliProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    fn display_name(&self) -> &str {
        "Codex (CLI)"
    }

    fn embedding_model_id(&self) -> &str {
        // Diagnostic sentinel — see `claude.rs` for the rationale.
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
            "Codex CLI does not support embeddings; pair with an embedding provider like Voyage or Ollama".into(),
        ))
    }

    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError> {
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
                "codex-cli task join failed: {join_err}"
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
        let _permit = tokio::select! {
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            p = self.concurrency.clone().acquire_owned() => p
                .map_err(|e| AiError::ProviderError(format!("semaphore closed: {e}")))?,
        };

        // Codex has no separate system-prompt flag — fold into body.
        let parts = build_prompt(messages);
        let prompt_arg = fold_system_into_body(&parts);

        let binary = self.resolve_binary()?;
        let model = opts
            .model
            .clone()
            .unwrap_or_else(|| self.chat_model.clone());

        // `--output-last-message` writes the final answer text to a tmp
        // file as a redundant fallback for the case where `--json`
        // doesn't carry a useful `agent_message` event (older builds /
        // mid-turn errors). The tmp file is read-only after the child
        // exits.
        let last_message_file = tempfile::NamedTempFile::new().map_err(|e| {
            AiError::ProviderError(format!(
                "failed to create tmp file for codex --output-last-message: {e}"
            ))
        })?;
        let last_message_path = last_message_file.path().to_path_buf();

        let mut cmd = Command::new(binary);
        cmd.arg("exec")
            .arg("--json")
            .arg("--skip-git-repo-check")
            .arg("--sandbox")
            .arg("read-only")
            .arg("-c")
            .arg("approval_policy=never")
            .arg("--ephemeral")
            .arg("--model")
            .arg(&model)
            .arg("--output-last-message")
            .arg(&last_message_path)
            .arg(&prompt_arg);

        // Codex 0.122 emits the full reply as a single `item.completed`
        // event, not a stream of deltas. A single mutex-protected
        // String is sufficient — no bridge channel needed (cf.
        // `claude.rs` which streams tokens via an unbounded bridge).
        // If a future Codex version starts streaming, flip this to
        // match the Claude pattern.
        let received_any = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let received_any_for_handler = received_any.clone();
        let bridge_text = Arc::new(std::sync::Mutex::new(String::new()));
        let bridge_text_for_handler = bridge_text.clone();

        let fatal: Arc<std::sync::Mutex<Option<AiError>>> = Arc::new(std::sync::Mutex::new(None));
        let fatal_for_handler = fatal.clone();
        let cancel_for_handler = cancel.clone();

        // We don't write anything to stdin — Codex reads the prompt
        // from the arg. Passing `Some("".to_string())` would make the
        // CLI block on `Reading additional input from stdin...`;
        // passing `None` closes stdin immediately. Closing stdin is
        // the correct posture (NOTES.md).
        let stream_result = spawn_jsonl(
            cmd,
            None,
            move |evt: Value| -> Result<bool, AiError> {
                if cancel_for_handler.is_cancelled() {
                    return Ok(false);
                }
                let t = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match t {
                    "thread.started" | "turn.started" => Ok(true),
                    "item.completed" => {
                        let item_type = evt
                            .get("item")
                            .and_then(|i| i.get("type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        match item_type {
                            // The model's reply text — the only thing
                            // we surface to the user.
                            "agent_message" => {
                                if let Some(text) = evt
                                    .get("item")
                                    .and_then(|i| i.get("text"))
                                    .and_then(|v| v.as_str())
                                {
                                    if !text.is_empty() {
                                        match bridge_text_for_handler.lock() {
                                            Ok(mut buf) => buf.push_str(text),
                                            Err(poisoned) => {
                                                poisoned.into_inner().push_str(text);
                                            }
                                        }
                                        received_any_for_handler
                                            .store(true, std::sync::atomic::Ordering::SeqCst);
                                    }
                                }
                                Ok(true)
                            }
                            // The model's chain-of-thought / hidden
                            // reasoning — harmless to ignore, but per
                            // privacy posture we explicitly do NOT
                            // forward it.
                            "reasoning" => Ok(true),
                            // Anything else is a privacy invariant
                            // violation. We asked for `--sandbox
                            // read-only -c approval_policy=never
                            // --ephemeral` precisely to disable tool
                            // calls. If `command_executed`,
                            // `mcp_tool_call`, `web_search_result`,
                            // `file_read`, or any future tool item
                            // surfaces, the model already executed
                            // something we didn't authorize — fail
                            // closed.
                            other => {
                                set_fatal(
                                    &fatal_for_handler,
                                    AiError::ProviderError(format!(
                                        "Codex CLI emitted a {other:?} item despite \
                                         --sandbox read-only + approval_policy=never. \
                                         Refusing to continue (privacy invariant)."
                                    )),
                                );
                                Ok(false)
                            }
                        }
                    }
                    "turn.completed" => {
                        // Defensive: a future schema may add inline
                        // failure indicators on turn.completed (a
                        // `status: "failed"`, a `truncated: true`, a
                        // `refusal` block). Surface any such signal
                        // as a fatal rather than treating the turn as
                        // clean.
                        if let Some(status) = evt.get("status").and_then(|v| v.as_str()) {
                            if status == "failed" || status == "cancelled" {
                                let reason = extract_error_msg(&evt);
                                set_fatal(
                                    &fatal_for_handler,
                                    AiError::ProviderError(format!("Codex CLI: {reason}")),
                                );
                            }
                        }
                        // Terminal event — stop the loop.
                        Ok(false)
                    }
                    "error" | "turn.failed" => {
                        let msg = extract_error_msg(&evt);
                        let lower = msg.to_ascii_lowercase();
                        let friendly = if lower.contains("not authenticated")
                            || lower.contains("login")
                            || lower.contains("unauthor")
                            || lower.contains("401")
                            || lower.contains("403")
                        {
                            "Codex CLI is not signed in. Run `codex login` once in a terminal."
                                .to_string()
                        } else if lower.contains("not supported")
                            || lower.contains("requires a newer version")
                        {
                            format!(
                                "Codex CLI: {msg} (try a different model in Settings, e.g. `gpt-5.4`)"
                            )
                        } else {
                            format!("Codex CLI: {msg}")
                        };
                        set_fatal(&fatal_for_handler, AiError::ProviderError(friendly));
                        Ok(false)
                    }
                    _ => Ok(true),
                }
            },
            cancel,
        )
        .await;

        // Fatal-first: a privacy violation, auth error, or
        // turn.failed must always win over whatever text we managed
        // to buffer. Poison-safe (we use `unwrap_or_else` rather than
        // `.ok()` which silently maps poison to None).
        let fatal_taken = match fatal.lock() {
            Ok(mut g) => g.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };

        // Forward whatever we buffered. If the agent_message event
        // never arrived AND the stream exited cleanly with no fatal,
        // read the fallback tmp file (older Codex builds wrote the
        // final answer only there).
        let mut final_text = match bridge_text.lock() {
            Ok(g) => g.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        let stream_clean = stream_result.is_ok() && fatal_taken.is_none();
        if !received_any.load(std::sync::atomic::Ordering::SeqCst) && stream_clean {
            if let Ok(fallback) = std::fs::read_to_string(&last_message_path) {
                let trimmed = fallback.trim();
                if !trimmed.is_empty() {
                    final_text.push_str(trimmed);
                }
            }
        }

        // Tmp file is reaped here regardless of return path — Rust's
        // Drop runs on all early returns, but binding to `_` makes
        // the intent explicit for the reader.
        let _ = last_message_file;

        if !final_text.is_empty() && stream_clean {
            // Best-effort: a closed receiver just means the caller
            // moved on — nothing to surface.
            let _ = tx.send(final_text.clone()).await;
        }
        drop(tx);

        if let Some(e) = fatal_taken {
            return Err(e);
        }
        if let Err(e) = stream_result {
            return Err(e);
        }
        // Empty reply on a clean stream is suspicious — Codex either
        // produced empty output or emitted an event shape we don't
        // recognize. Surface as a typed error rather than `Ok("")`
        // so the caller's UI doesn't show a blank reply with no
        // explanation.
        if final_text.is_empty() {
            return Err(AiError::ProviderError(
                "Codex CLI returned no reply. The model may have produced empty output, \
                 or the CLI version may emit events this build does not recognize. \
                 Try a different model in Settings (e.g. `gpt-5.4`)."
                    .into(),
            ));
        }
        Ok(())
    }
}

/// Poison-safe `Option<AiError>` setter. The handler closure is
/// `FnMut + Send`, so it cannot propagate a panic out — but a panic
/// during `push_str` on `bridge_text` would poison `fatal` too.
/// Recover via `into_inner` so we never silently drop a fatal error
/// (which would convert "auth failure" into "blank AI reply").
fn set_fatal(slot: &Arc<std::sync::Mutex<Option<AiError>>>, err: AiError) {
    match slot.lock() {
        Ok(mut g) => *g = Some(err),
        Err(poisoned) => *poisoned.into_inner() = Some(err),
    }
}

/// Extract a human-readable error message from a Codex event.
/// Codex error events have several plausible shapes (varies by
/// version and the upstream OpenAI error wrapping). Walk a priority
/// list of likely keys at the top level and inside an `error`
/// sub-object; fall back to a generic placeholder.
fn extract_error_msg(evt: &Value) -> String {
    for key in ["message", "detail", "reason"] {
        if let Some(s) = evt.get(key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    if let Some(err) = evt.get("error") {
        if let Some(s) = err.as_str() {
            if !s.is_empty() {
                return s.to_string();
            }
        }
        for key in ["message", "detail", "reason"] {
            if let Some(s) = err.get(key).and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    "Codex CLI returned an error".to_string()
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

    fn shell_escape(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    /// Build a stub script that mimics `codex exec` enough to test
    /// the parser. `stdout_lines` are echoed before exit; if
    /// `last_message_text` is `Some`, the script also writes that
    /// string to the path passed via `--output-last-message`.
    fn write_codex_stub(
        tmp: &tempfile::TempDir,
        stdout_lines: &[&str],
        last_message_text: Option<&str>,
    ) -> PathBuf {
        let path = tmp.path().join("codex-stub");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "#!/bin/bash").unwrap();
        // Crude arg walk: find `--output-last-message` then read the
        // next arg as the path.
        writeln!(
            f,
            r#"out=""; while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) shift; out="$1"; shift;;
    *) shift;;
  esac
done"#
        )
        .unwrap();
        if let Some(text) = last_message_text {
            writeln!(
                f,
                r#"if [ -n "$out" ]; then printf '%s' {} > "$out"; fi"#,
                shell_escape(text)
            )
            .unwrap();
        }
        for line in stdout_lines {
            writeln!(f, "echo {}", shell_escape(line)).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[tokio::test]
    async fn embed_returns_unsupported() {
        let p = CodexCliProvider::new("gpt-5.4");
        let err = p.embed(&["hi"]).await.expect_err("must Err");
        assert!(matches!(err, AiError::ProviderUnsupported(_)));
    }

    #[test]
    fn provider_metadata() {
        let p = CodexCliProvider::new("gpt-5.4");
        assert_eq!(p.id(), "codex-cli");
        assert_eq!(p.display_name(), "Codex (CLI)");
        assert_eq!(p.chat_model_id(), "gpt-5.4");
        assert_eq!(p.embedding_model_id(), "unsupported");
    }

    #[tokio::test]
    async fn chat_forwards_agent_message_text() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started","thread_id":"t1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hello from codex"}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let out = p
            .chat(&[msg(MessageRole::User, "say hi")], ChatOpts::default())
            .await
            .expect("must succeed");
        assert_eq!(out, "hello from codex");
    }

    #[tokio::test]
    async fn chat_falls_back_to_output_file_when_no_agent_message() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started","thread_id":"t1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"turn.completed","usage":{}}"#,
            ],
            Some("fallback answer from file"),
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let out = p
            .chat(&[msg(MessageRole::User, "hi")], ChatOpts::default())
            .await
            .expect("must succeed via fallback");
        assert_eq!(out, "fallback answer from file");
    }

    #[tokio::test]
    async fn chat_surfaces_auth_failure_with_friendly_message() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started"}"#,
                r#"{"type":"turn.failed","error":{"message":"not authenticated. Run `codex login`."}}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("not signed in"), "msg was: {m}");
                assert!(m.contains("codex login"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_surfaces_model_unavailable_with_hint() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"turn.failed","error":{"message":"The 'gpt-5.5' model requires a newer version of Codex."}}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.5", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("try a different model"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_ignores_unknown_top_level_event_types() {
        // Defensive parser: unknown top-level event types must not
        // crash or leak into the output.
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started"}"#,
                r#"{"type":"some_future_event","payload":"ignored"}"#,
                r#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}"#,
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}"#,
                r#"{"type":"turn.completed"}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let out = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .unwrap();
        assert_eq!(out, "ok");
    }

    /// Privacy invariant: `--sandbox read-only -c approval_policy=never`
    /// should make tool calls impossible. If a `command_executed`
    /// item.completed surfaces anyway (MCP server in user config,
    /// model hallucinating an unsandboxed call, schema drift), the
    /// provider must abort rather than silently relay the answer.
    #[tokio::test]
    async fn chat_aborts_when_cli_emits_command_executed_item() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started"}"#,
                r#"{"type":"item.completed","item":{"type":"command_executed","command":"rm -rf /"}}"#,
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#,
                r#"{"type":"turn.completed"}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err on command_executed");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("command_executed"), "msg was: {m}");
                assert!(m.contains("privacy"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn chat_aborts_when_cli_emits_mcp_tool_call_item() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"item.completed","item":{"type":"mcp_tool_call","server":"slack","tool":"send_message"}}"#,
                r#"{"type":"turn.completed"}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err on mcp_tool_call");
        assert!(
            matches!(err, AiError::ProviderError(ref m) if m.contains("mcp_tool_call") && m.contains("privacy"))
        );
    }

    /// Empty reply on a clean stream must surface as a typed error
    /// so the UI doesn't show a blank assistant message with no
    /// explanation.
    #[tokio::test]
    async fn chat_errors_on_empty_reply() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"thread.started"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"turn.completed"}"#,
            ],
            None, // no fallback file either
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("empty reply must Err, not Ok(\"\")");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("no reply"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    /// turn.completed with status=failed must surface as a fatal,
    /// not be treated as clean.
    #[tokio::test]
    async fn chat_surfaces_failed_turn_completed() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}"#,
                r#"{"type":"turn.completed","status":"failed","reason":"context length exceeded"}"#,
            ],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("failed turn must Err");
        match err {
            AiError::ProviderError(m) => {
                assert!(m.contains("context length"), "msg was: {m}");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    /// I3 regression: error events with the message buried under
    /// `error.detail` (no top-level `message`, no `error.message`)
    /// must still produce a usable error string.
    #[tokio::test]
    async fn chat_extracts_error_from_nested_detail_field() {
        let tmp = tempfile::tempdir().unwrap();
        let stub = write_codex_stub(
            &tmp,
            &[r#"{"type":"error","error":{"code":"some_code","detail":"backend unreachable"}}"#],
            None,
        );
        let p = CodexCliProvider::with_binary("gpt-5.4", stub);
        let err = p
            .chat(&[msg(MessageRole::User, "x")], ChatOpts::default())
            .await
            .expect_err("must Err");
        assert!(matches!(err, AiError::ProviderError(m) if m.contains("backend unreachable")));
    }

    #[test]
    fn extract_error_msg_priority_order() {
        // Top-level `message` wins over everything.
        let v = serde_json::json!({"type":"error","message":"top","error":{"message":"inner"}});
        assert_eq!(extract_error_msg(&v), "top");
        // No top-level → look inside `error`.
        let v = serde_json::json!({"type":"error","error":{"detail":"nested"}});
        assert_eq!(extract_error_msg(&v), "nested");
        // Bare string error field.
        let v = serde_json::json!({"type":"error","error":"boom"});
        assert_eq!(extract_error_msg(&v), "boom");
        // Nothing recognisable → placeholder.
        let v = serde_json::json!({"type":"error","foo":"bar"});
        assert_eq!(extract_error_msg(&v), "Codex CLI returned an error");
    }

    /// Smoke test against the real `codex` binary. Opt in with
    /// `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_codex_subprocess_smoke() {
        let p = CodexCliProvider::new("gpt-5.4");
        let out = p
            .chat(
                &[msg(MessageRole::User, "say 'pong' and nothing else")],
                ChatOpts::default(),
            )
            .await
            .expect("real codex call must succeed (run `codex login` if it fails)");
        assert!(!out.trim().is_empty(), "got empty reply");
    }
}
