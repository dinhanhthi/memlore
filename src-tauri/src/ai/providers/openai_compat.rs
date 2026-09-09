//! `OpenAICompatibleProvider` — HTTP client for the OpenAI chat-completions /
//! embeddings / images wire format.
//!
//! One impl, every preset. See the module-level doc on `super` for the
//! full provider matrix.
//!
//! ## Wire shapes
//!
//! - **Embeddings** `POST {endpoint}/embeddings`
//!   request:  `{ "model": "...", "input": ["..."] }`
//!   response: `{ "data": [{ "embedding": [...], "index": 0 }, ...] }`
//!
//! - **Chat** `POST {endpoint}/chat/completions`
//!   request:  `{ "model": "...", "messages": [...], "temperature": ?, "max_tokens": ? }`
//!   response: `{ "choices": [{ "message": { "role": "...", "content": "..." } }] }`
//!
//! - **OpenAI Pro chat** `POST {endpoint}/responses`
//!   request:  `{ "model": "...", "input": [...], "max_output_tokens": ?, "store": false }`
//!   response: `{ "output": [{ "content": [{ "type": "output_text", "text": "..." }] }] }`
//!
//! - **Images** `POST {endpoint}/images/generations`
//!   request:  `{ "model": "...", "prompt": "...", "size": "1024x1024", "n": 1 }`
//!   response: `{ "data": [{ "url": "..." } | { "b64_json": "..." }] }`
//!
//! ## Error mapping
//!
//! | HTTP | `AiError`                         |
//! |------|-----------------------------------|
//! | 401, 403 | `AuthFailed`                  |
//! | 429      | `RateLimited`                 |
//! | 5xx, network, malformed JSON | `ProviderError(detail)` |
//!
//! Every `ProviderError` string is funnelled through
//! [`crate::utils::secrets::redact_secret`] so an API key that escapes into
//! a `reqwest::Error` `Display` impl never lands in the log.
//!
//! ## Security: no `derive(Debug)`, key bytes never hit a non-zeroizable String
//!
//! The provider holds the user's API key in memory. We implement `Debug`
//! manually so the field renders as `"<redacted>"` regardless of which
//! formatter the caller picks (`{:?}`, `{:#?}`, panic backtraces). The
//! key itself is stored as `Zeroizing<String>` so its bytes are wiped on
//! drop.
//!
//! The bearer header is built via `HeaderValue::from_bytes` against a
//! `Zeroizing<Vec<u8>>` — we deliberately do NOT use
//! `format!("Bearer {key}")` because the resulting `String` is not
//! zeroizable, persists on the heap until allocator reclaim, and would
//! re-introduce exactly the leak vector the rest of this defence-in-
//! depth posture is designed to close.

use crate::ai::audit::{TokenUsage, TokenUsageSlot};
use crate::ai::error::AiError;
use crate::ai::provider::{
    classify_endpoint, AIProvider, ChatOpts, EndpointClass, ImageOpts, Message, MessageRole,
};
use crate::utils::secrets::redact_secret;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::Duration;
use zeroize::Zeroizing;

/// Default request timeout. Embedding and chat both use this; image gen is
/// allowed a longer window because GPT image models (`gpt-image-*`) routinely
/// take 60–200s even at medium quality (high/auto can exceed 3 minutes).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const IMAGE_GEN_TIMEOUT: Duration = Duration::from_secs(360);
const RESPONSES_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_PRO_OUTPUT_TOKENS: u32 = 8192;

/// Soft cap on a single response body. Bounds malicious-provider DoS and
/// keeps OOM out of reach if a misconfigured upstream returns a huge blob.
/// Embeddings + chat + base64 images all comfortably fit; multi-image batches
/// or HD video would not — we don't generate either.
const MAX_RESPONSE_BYTES: usize = 50 * 1024 * 1024;

/// Soft cap for a fetched image (image-gen URL response path). Higher than
/// MAX_RESPONSE_BYTES so high-res PNG outputs (1024×1024 transparent → ~10MB)
/// aren't truncated, but still bounded.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Concrete provider talking the OpenAI-compatible wire format.
///
/// `endpoint` is the API base — no trailing slash; we append `/embeddings`,
/// `/chat/completions`, `/images/generations` ourselves.
///
/// `api_key` is `None` for unauthenticated local servers (Ollama in default
/// mode, llama.cpp `llama-server`, LM Studio). When `Some`, every outbound
/// request gets `Authorization: Bearer <key>`.
///
/// `image_model` is `None` when the configured provider doesn't support
/// image gen (the bulk of local servers). `generate_image` returns
/// `ProviderUnsupported` in that case.
pub struct OpenAICompatibleProvider {
    id: String,
    display_name: String,
    endpoint: String,
    /// `Zeroizing<String>` so the underlying bytes are wiped on drop. Same
    /// posture as the unlock-time master password. Wrapped in `Option` so
    /// loopback / unauthenticated local servers can leave it unset.
    api_key: Option<Zeroizing<String>>,
    chat_model: String,
    embedding_model: String,
    image_model: Option<String>,
    /// Default-timeout client (DEFAULT_TIMEOUT). Used by embed + chat.
    client: reqwest::Client,
    /// Long-timeout client (IMAGE_GEN_TIMEOUT). Built once at construction
    /// so each `generate_image` call reuses the same TLS connection pool
    /// and FD set — a per-call client would cost ~200ms + a fresh TLS
    /// handshake every time.
    image_client: reqwest::Client,
    /// Token-usage slot injected by `AuditingProvider`. Written from
    /// `embed` / `chat` just before returning. `None` when no audit
    /// decorator is wrapping this provider.
    usage_sink: RwLock<Option<TokenUsageSlot>>,
}

/// Manual `Debug` so the API key never leaks into a panic backtrace, a
/// `log::warn!("{:?}", provider)`, or any other `{:?}` formatter use. The
/// rest of the fields are safe to render — they're configuration the user
/// supplied via Settings, not secrets.
impl std::fmt::Debug for OpenAICompatibleProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAICompatibleProvider")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("endpoint", &self.endpoint)
            .field(
                "api_key",
                &if self.api_key.is_some() {
                    "<redacted>"
                } else {
                    "<none>"
                },
            )
            .field("chat_model", &self.chat_model)
            .field("embedding_model", &self.embedding_model)
            .field("image_model", &self.image_model)
            .field("usage_sink", &"<audit slot>")
            .finish()
    }
}

/// Builder-style config for [`OpenAICompatibleProvider::new`]. Kept as a
/// plain struct (not a builder) since it's rarely held — the Settings panel
/// calls `set_ai_provider` once per change, instantiates one provider, and
/// hands it to [`crate::ai::provider_registry`] (added in this chunk).
#[derive(Clone)]
pub struct OpenAICompatibleConfig {
    /// Provider id used as the `entries_embeddings.model_id` namespace
    /// prefix (e.g. `"openai"`, `"ollama"`, `"custom"`). MUST be stable
    /// per-provider — switching from `"openai"` to `"custom"` invalidates
    /// the embedding cache.
    pub id: String,
    /// Human-readable label for UI (e.g. `"OpenAI"`, `"Ollama (local)"`).
    pub display_name: String,
    /// API base, no trailing slash. We append `/embeddings`, etc.
    pub endpoint: String,
    /// Bearer key — `Zeroizing<String>` so the underlying bytes are wiped on
    /// drop. `None` for unauthenticated local servers.
    pub api_key: Option<Zeroizing<String>>,
    pub chat_model: String,
    pub embedding_model: String,
    pub image_model: Option<String>,
}

/// `OpenAICompatibleConfig` deliberately implements `Debug` manually so
/// `api_key` doesn't leak into log lines / panic traces. Same posture as
/// the active provider struct above.
impl std::fmt::Debug for OpenAICompatibleConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAICompatibleConfig")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("endpoint", &self.endpoint)
            .field(
                "api_key",
                &if self.api_key.is_some() {
                    "<redacted>"
                } else {
                    "<none>"
                },
            )
            .field("chat_model", &self.chat_model)
            .field("embedding_model", &self.embedding_model)
            .field("image_model", &self.image_model)
            .finish()
    }
}

impl OpenAICompatibleProvider {
    /// Build a fresh provider. Fails only if the underlying `reqwest::Client`
    /// can't be constructed (e.g. native TLS init error).
    pub fn new(cfg: OpenAICompatibleConfig) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| AiError::ProviderError(format!("HTTP client init failed: {e}")))?;
        let image_client = reqwest::Client::builder()
            .timeout(IMAGE_GEN_TIMEOUT)
            .build()
            .map_err(|e| AiError::ProviderError(format!("HTTP client init failed: {e}")))?;
        Ok(Self {
            id: cfg.id,
            display_name: cfg.display_name,
            endpoint: cfg.endpoint.trim_end_matches('/').to_owned(),
            api_key: cfg.api_key,
            chat_model: cfg.chat_model,
            embedding_model: cfg.embedding_model,
            image_model: cfg.image_model,
            client,
            image_client,
            usage_sink: RwLock::new(None),
        })
    }

    /// Bearer header for the current key, with `HeaderValue::sensitive(true)`
    /// so the value is masked in `reqwest::Debug` impls. A missing key
    /// yields an empty header map (some local servers reject any
    /// `Authorization` header at all, so we just don't send one).
    ///
    /// The header value is built via `from_bytes` against a `Vec<u8>` we
    /// zeroize after the move. We deliberately AVOID `format!("Bearer {key}")`
    /// — the intermediate `String` is not zeroizable, would persist on the
    /// heap until the next allocator reclaim, and is exactly the pattern the
    /// module-level "Security" note forbids.
    fn auth_headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(ref key) = self.api_key {
            // Build the bearer value as bytes so the secret never lands in
            // a non-zeroizable String. Wrap in Zeroizing so the buffer is
            // wiped after `from_bytes` clones it into the HeaderValue.
            let mut buf: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(7 + key.len()));
            buf.extend_from_slice(b"Bearer ");
            buf.extend_from_slice(key.as_bytes());
            // Bearer values must be ASCII / visible; from_bytes rejects
            // anything that isn't a valid HeaderValue. Highly unusual for a
            // user-supplied API key — fall back to no header rather than
            // crashing.
            if let Ok(mut hv) = HeaderValue::from_bytes(&buf) {
                hv.set_sensitive(true);
                h.insert(AUTHORIZATION, hv);
            }
        }
        h
    }

    /// `true` when the configured endpoint is OpenAI's hosted API. Used to
    /// branch the chat-request wire format: GPT-5.x / o-series models
    /// reject `max_tokens` (must be `max_completion_tokens`) and use a
    /// different `reasoning_effort` vocabulary than Ollama et al.
    /// Loose-dialect (Ollama, LM Studio, llama.cpp, OpenRouter, Anthropic
    /// shim) still wants the legacy fields — keeping it endpoint-gated
    /// avoids regressing those.
    fn is_openai_strict(&self) -> bool {
        // Match `api.openai.com` exactly and any `*.api.openai.com` subdomain.
        // url::Url is overkill for this — a substring check suffices and
        // doesn't pull a parser into the hot path. The match is anchored on
        // host boundary characters (`/`, `:`, end-of-string after `://`)
        // so `notapi.openai.com` doesn't false-positive.
        self.endpoint
            .strip_prefix("https://")
            .or_else(|| self.endpoint.strip_prefix("http://"))
            .map(|rest| {
                let host = rest.split(['/', ':']).next().unwrap_or("");
                host == "api.openai.com" || host.ends_with(".api.openai.com")
            })
            .unwrap_or(false)
    }

    /// Funnel a `String` (typically a `reqwest::Error::to_string()`)
    /// through the redactor before returning it to the caller. Centralised
    /// so every error path stays consistent — see the module-level
    /// "Security" note.
    fn scrub(&self, s: String) -> String {
        match self.api_key.as_ref().map(|k| k.as_str()) {
            Some(k) if !k.is_empty() => redact_secret(s, k),
            _ => s,
        }
    }

    /// Write token usage into the audit slot if one has been registered via
    /// `set_usage_sink`. Called just before `embed` / `chat` return.
    fn write_usage(&self, prompt_tokens: Option<u32>, completion_tokens: Option<u32>) {
        if let Ok(guard) = self.usage_sink.read() {
            if let Some(ref slot) = *guard {
                if let Ok(mut usage) = slot.lock() {
                    *usage = Some(TokenUsage {
                        tokens_in: prompt_tokens,
                        tokens_out: completion_tokens,
                    });
                }
            }
        }
    }

    /// Read up to `limit` bytes from a streaming response. Returns
    /// `ProviderError` if the body would exceed the cap.
    ///
    /// Why: `reqwest::Response::bytes()` reads the full body into memory with
    /// no upstream cap — a malicious / misconfigured provider returning a
    /// 5GB blob would OOM the app. Streaming-with-cap bounds the worst case.
    async fn bytes_with_cap(resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, AiError> {
        // Honour Content-Length when present — fail fast before reading.
        if let Some(len) = resp.content_length() {
            if len as usize > limit {
                return Err(AiError::ProviderError(format!(
                    "response body too large: {} bytes (limit {})",
                    len, limit
                )));
            }
        }
        let mut acc: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| AiError::ProviderError(format!("response stream failed: {e}")))?;
            if acc.len() + chunk.len() > limit {
                return Err(AiError::ProviderError(format!(
                    "response body exceeded {} bytes",
                    limit
                )));
            }
            acc.extend_from_slice(&chunk);
        }
        Ok(acc)
    }

    /// Map an HTTP response into either the parsed body bytes (on 2xx) or
    /// the appropriate `AiError` variant. Centralised so embed / chat /
    /// generate_image share one error mapping.
    async fn handle_status(&self, resp: reqwest::Response) -> Result<Vec<u8>, AiError> {
        let status = resp.status();
        if status.is_success() {
            return Self::bytes_with_cap(resp, MAX_RESPONSE_BYTES)
                .await
                .map_err(|e| match e {
                    AiError::ProviderError(s) => AiError::ProviderError(self.scrub(s)),
                    other => other,
                });
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AiError::AuthFailed);
        }
        if status.as_u16() == 429 {
            return Err(AiError::RateLimited);
        }
        // Capture response body so the user sees the upstream error message
        // (truncated + scrubbed). reqwest's default `Display` doesn't
        // include the body — we have to read it ourselves.
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(512).collect();
        Err(AiError::ProviderError(
            self.scrub(format!("HTTP {status}: {snippet}")),
        ))
    }

    async fn chat_via_responses(
        &self,
        messages: &[Message],
        opts: &ChatOpts,
        model: &str,
    ) -> Result<String, AiError> {
        let url = format!("{}/responses", self.endpoint);
        let input = messages
            .iter()
            .map(|message| ChatRequestMessage {
                role: role_str(message.role),
                content: &message.content,
            })
            .collect();
        let body = build_responses_request(model, input, opts);
        let resp = self
            .client
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .timeout(RESPONSES_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                AiError::ProviderError(self.scrub(format!("responses request failed: {e}")))
            })?;
        let bytes = self.handle_status(resp).await?;
        let parsed: ResponsesResponse = serde_json::from_slice(&bytes).map_err(|e| {
            AiError::ProviderError(self.scrub(format!("responses JSON parse failed: {e}")))
        })?;
        let content = responses_output_text(&parsed)?.ok_or_else(|| {
            AiError::ProviderError("responses: response had no output_text content".into())
        })?;
        let (input_tokens, output_tokens) = parsed
            .usage
            .map(|usage| (usage.input_tokens, usage.output_tokens))
            .unwrap_or((None, None));
        self.write_usage(input_tokens, output_tokens);
        Ok(content)
    }
}

// ─── Wire format types ─────────────────────────────────────────────────────

/// Token-usage field present in most OpenAI-compat responses.
/// Both fields are optional (`serde(default)`) because local servers
/// (Ollama, llama.cpp) often omit the entire `usage` object.
#[derive(Deserialize, Default)]
struct ResponseUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

#[derive(Serialize)]
struct EmbeddingsRequest<'a> {
    model: &'a str,
    input: &'a [&'a str],
}

#[derive(Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingDatum>,
    #[serde(default)]
    usage: Option<ResponseUsage>,
}

#[derive(Deserialize)]
struct EmbeddingDatum {
    embedding: Vec<f32>,
    #[serde(default)]
    index: Option<usize>,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatRequestMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    /// Loose-dialect token cap (Ollama, LM Studio, llama.cpp, OpenRouter,
    /// Anthropic shim, …). OpenAI's hosted API rejects this for GPT-5.x /
    /// o-series with `unsupported_parameter` — strict-dialect requests use
    /// `max_completion_tokens` instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// Strict-dialect token cap. GPT-5.x and o-series only accept this
    /// field; older models on api.openai.com auto-convert from `max_tokens`
    /// but the new ones hard-fail.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    /// `true` for streaming-SSE responses, omitted otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
    /// Suppress Ollama's reasoning channel and select a documented OpenAI
    /// reasoning level that preserves room for visible output. Other
    /// compatible providers omit this extension conservatively.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'static str>,
    /// Stream-only request directive. When `stream: true`, providers with
    /// documented support only return the `usage` field in the response if
    /// `stream_options.include_usage` is set to `true`. Without it,
    /// streaming responses carry zero token-count data and every
    /// streaming AI feature shows `—` for tokens in the audit log.
    /// The request policy emits this only for providers with documented
    /// support; other providers still stream content without usage metrics.
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
}

#[derive(Serialize)]
struct ResponsesRequest<'a> {
    model: &'a str,
    input: Vec<ChatRequestMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    reasoning: ResponsesReasoning,
    store: bool,
}

#[derive(Serialize)]
struct ResponsesReasoning {
    effort: &'static str,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// Wire shape of one SSE chunk emitted by the OpenAI-compat
/// `/chat/completions` endpoint when `stream: true`. Each line is
/// `data: <json>` followed by a blank line; the final line is
/// `data: [DONE]` (handled separately as a string match — not parsed
/// as JSON).
///
/// `usage` appears only in the final pre-`[DONE]` chunk when the request
/// included `stream_options.include_usage = true`. That chunk has an
/// empty `choices` array, so the SSE loop must check `usage` even when
/// no `delta.content` was emitted.
#[derive(Deserialize)]
struct ChatStreamChunk {
    #[serde(default)]
    choices: Vec<ChatStreamChoice>,
    #[serde(default)]
    usage: Option<ResponseUsage>,
}

#[derive(Deserialize)]
struct ChatStreamChoice {
    #[serde(default)]
    delta: ChatStreamDelta,
}

#[derive(Deserialize, Default)]
struct ChatStreamDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Serialize)]
struct ChatRequestMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<ResponseUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    #[allow(dead_code)]
    role: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
struct ResponsesResponse {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    incomplete_details: Option<ResponsesIncompleteDetails>,
    #[serde(default)]
    output_text: Option<String>,
    #[serde(default)]
    output: Vec<ResponsesOutputItem>,
    #[serde(default)]
    usage: Option<ResponsesUsage>,
}

#[derive(Deserialize)]
struct ResponsesIncompleteDetails {
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct ResponsesOutputItem {
    #[serde(default)]
    content: Vec<ResponsesContentItem>,
}

#[derive(Deserialize)]
struct ResponsesContentItem {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct ResponsesUsage {
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
}

#[derive(Serialize)]
struct ImageRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    n: Option<u32>,
    /// GPT image models only (`low` | `medium` | `high` | `auto`).
    /// DALL·E uses different quality enums; never send this for non-gpt-image.
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<&'static str>,
}

#[derive(Deserialize)]
struct ImageResponse {
    data: Vec<ImageDatum>,
}

#[derive(Deserialize)]
struct ImageDatum {
    url: Option<String>,
    b64_json: Option<String>,
}

/// Find the byte index of the first CRLF-CRLF or LF-LF SSE event
/// terminator. Returns `None` when the buffer doesn't yet contain a
/// complete event (caller waits for more bytes from the stream).
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    // SSE events are delimited by `\n\n` per spec, but some servers /
    // proxies emit `\r\n\r\n`. Use whichever terminator appears first
    // so a mixed-style buffer does not merge two frames.
    let lf = buf.windows(2).position(|w| w == b"\n\n");
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(a), Some(b)) if b < a => Some(b + 2),
        (Some(a), _) => Some(a),
        (None, Some(b)) => Some(b + 2),
        (None, None) => None,
    }
}

/// Split off every complete SSE event (`\n\n`- or `\r\n\r\n`-terminated,
/// terminator included) from the front of `buf`, compacting the buffer
/// once per network chunk — not per event. Mixed terminators split at
/// whichever delimiter appears first in the buffer.
/// Incomplete trailing bytes stay in `buf` for the next network chunk.
/// Invalid UTF-8 becomes an empty string (skipped by `parse_sse_data`).
fn drain_sse_events(buf: &mut Vec<u8>) -> Vec<String> {
    let mut events = Vec::new();
    let mut start = 0;
    while let Some(idx) = find_double_newline(&buf[start..]) {
        let end = start + idx + 2;
        events.push(String::from_utf8(buf[start..end].to_vec()).unwrap_or_default());
        start = end;
    }
    buf.drain(..start);
    events
}

/// Pull the `data:` payload(s) out of a complete SSE event (one
/// frame ending with `\n\n`). An event may have multiple `data:`
/// lines per spec — they get joined with `\n`. Returns `None` for
/// comment-only events (lines starting with `:`) or events with no
/// data.
fn parse_sse_data(event: &str) -> Option<String> {
    let mut data_lines: Vec<&str> = Vec::new();
    for raw_line in event.lines() {
        let line = raw_line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("data:") {
            // RFC: a single space after `:` is consumed; everything
            // else is the payload as-is.
            let payload = rest.strip_prefix(' ').unwrap_or(rest);
            data_lines.push(payload);
        }
        // Lines starting with `:` are SSE comments; ignored.
        // Other field types (`event:`, `id:`, `retry:`) we don't need.
    }
    if data_lines.is_empty() {
        None
    } else {
        Some(data_lines.join("\n"))
    }
}

fn role_str(r: MessageRole) -> &'static str {
    match r {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    }
}

/// `true` when `model` is in a GPT-5.5/5.6 family confirmed to accept
/// `reasoning_effort: "none"` on OpenAI's strict dialect. GPT-5.5 Pro is
/// excluded because it only supports medium/high/xhigh. Matching is
/// case-sensitive so mistyped model IDs fall through to the safe "omit"
/// branch.
fn is_openai_gpt_5_5_pro(model: &str) -> bool {
    model == "gpt-5.5-pro" || model.starts_with("gpt-5.5-pro-")
}

fn chat_api_path(official_openai_endpoint: bool, model: &str) -> &'static str {
    if official_openai_endpoint && is_openai_gpt_5_5_pro(model) {
        "responses"
    } else {
        "chat/completions"
    }
}

fn openai_supports_reasoning_none(model: &str) -> bool {
    (model.starts_with("gpt-5.5") && !is_openai_gpt_5_5_pro(model)) || model.starts_with("gpt-5.6")
}

fn openai_reasoning_effort(model: &str) -> Option<&'static str> {
    if openai_supports_reasoning_none(model) {
        Some("none")
    } else if model == "gpt-5-mini" || model.starts_with("gpt-5-mini-") {
        Some("minimal")
    } else {
        None
    }
}

fn is_gpt_5_family(model: &str) -> bool {
    model == "gpt-5" || model.starts_with("gpt-5-") || model.starts_with("gpt-5.")
}

#[derive(Clone, Copy)]
enum TokenLimitField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Clone, Copy)]
struct ChatWirePolicy {
    send_temperature: bool,
    token_limit: Option<TokenLimitField>,
    reasoning_effort: Option<&'static str>,
    stream_usage: bool,
}

fn anthropic_restricts_temperature(model: &str) -> bool {
    if model == "claude-sonnet-5" || model.starts_with("claude-sonnet-5-") {
        return true;
    }

    let Some(version) = model.strip_prefix("claude-opus-") else {
        return false;
    };
    let mut parts = version.split('-');
    let major = parts.next().and_then(|value| value.parse::<u32>().ok());
    let minor = parts.next().and_then(|value| value.parse::<u32>().ok());
    matches!(
        (major, minor),
        (Some(major), _) if major >= 5
    ) || matches!((major, minor), (Some(4), Some(minor)) if minor >= 7)
}

fn chat_wire_policy(
    provider_id: &str,
    official_openai_endpoint: bool,
    model: &str,
) -> ChatWirePolicy {
    let official_openai = provider_id == "openai" && official_openai_endpoint;
    let known_compatible_provider = matches!(
        provider_id,
        "ollama"
            | "lmstudio"
            | "llama-server"
            | "on-device-llm"
            | "anthropic"
            | "gemini"
            | "xai"
            | "openrouter"
            | "together"
            | "groq"
    );
    let restricts_temperature = (official_openai && is_gpt_5_family(model))
        || (provider_id == "anthropic" && anthropic_restricts_temperature(model));
    let reasoning_effort = if official_openai {
        openai_reasoning_effort(model)
    } else if provider_id == "ollama" {
        Some("none")
    } else {
        None
    };

    ChatWirePolicy {
        send_temperature: (official_openai || known_compatible_provider) && !restricts_temperature,
        token_limit: if official_openai {
            Some(TokenLimitField::MaxCompletionTokens)
        } else if known_compatible_provider {
            Some(TokenLimitField::MaxTokens)
        } else {
            None
        },
        reasoning_effort,
        stream_usage: official_openai
            || matches!(
                provider_id,
                "ollama" | "anthropic" | "lmstudio" | "xai" | "openrouter" | "groq"
            ),
    }
}

fn build_chat_request<'a>(
    provider_id: &str,
    official_openai_endpoint: bool,
    model: &'a str,
    messages: Vec<ChatRequestMessage<'a>>,
    opts: &ChatOpts,
    stream: bool,
) -> ChatRequest<'a> {
    let policy = chat_wire_policy(provider_id, official_openai_endpoint, model);
    let stream = stream && !(official_openai_endpoint && is_openai_gpt_5_5_pro(model));
    let (max_tokens, max_completion_tokens) = match policy.token_limit {
        Some(TokenLimitField::MaxTokens) => (opts.max_tokens, None),
        Some(TokenLimitField::MaxCompletionTokens) => (None, opts.max_tokens),
        None => (None, None),
    };
    ChatRequest {
        model,
        messages,
        temperature: if policy.send_temperature {
            opts.temperature
        } else {
            None
        },
        max_tokens,
        max_completion_tokens,
        stream,
        reasoning_effort: policy.reasoning_effort,
        stream_options: (stream && policy.stream_usage).then_some(StreamOptions {
            include_usage: true,
        }),
    }
}

fn build_responses_request<'a>(
    model: &'a str,
    input: Vec<ChatRequestMessage<'a>>,
    opts: &ChatOpts,
) -> ResponsesRequest<'a> {
    ResponsesRequest {
        model,
        input,
        max_output_tokens: opts
            .max_tokens
            .map(|tokens| tokens.max(MIN_PRO_OUTPUT_TOKENS)),
        reasoning: ResponsesReasoning { effort: "medium" },
        store: false,
    }
}

fn responses_output_text(response: &ResponsesResponse) -> Result<Option<String>, AiError> {
    if response.status.as_deref() == Some("incomplete") {
        let reason = response
            .incomplete_details
            .as_ref()
            .and_then(|details| details.reason.as_deref())
            .unwrap_or("unknown");
        return Err(AiError::ProviderError(format!(
            "responses: incomplete response ({reason})"
        )));
    }

    if let Some(output_text) = response.output_text.as_ref() {
        return Ok(Some(output_text.clone()));
    }

    let mut found = false;
    let mut output = String::new();
    for text in response
        .output
        .iter()
        .flat_map(|item| item.content.iter())
        .filter(|content| content.kind.as_deref() == Some("output_text"))
        .filter_map(|content| content.text.as_ref())
    {
        found = true;
        output.push_str(text);
    }
    Ok(found.then_some(output))
}

fn xai_image_dimensions(size: Option<&str>) -> (Option<&'static str>, Option<&'static str>) {
    match size {
        Some("1024x1024") => (Some("1:1"), Some("1k")),
        // Accept both DALL·E-era (1792) and GPT-image (1536) UI size tokens.
        Some("1024x1792") | Some("1024x1536") => (Some("9:16"), Some("1k")),
        Some("1792x1024") | Some("1536x1024") => (Some("16:9"), Some("1k")),
        _ => (None, None),
    }
}

fn image_pixel_dimensions(size: Option<&str>) -> (Option<u32>, Option<u32>) {
    match size {
        Some("1024x1024") => (Some(1024), Some(1024)),
        // UI portrait/landscape labels — accept both DALL·E-era and GPT-image sizes.
        Some("1024x1792") => (Some(1024), Some(1792)),
        Some("1024x1536") => (Some(1024), Some(1536)),
        Some("1792x1024") => (Some(1792), Some(1024)),
        Some("1536x1024") => (Some(1536), Some(1024)),
        _ => (None, None),
    }
}

/// GPT image models (`gpt-image-1`, `gpt-image-2`, …) reject DALL·E-3 sizes
/// and prefer the 1536-based portrait/landscape pair. Map the UI's shared
/// size tokens so a single frontend list works for all providers.
fn openai_gpt_image_size(size: Option<&str>) -> Option<&str> {
    match size {
        Some("1024x1792") => Some("1024x1536"),
        Some("1792x1024") => Some("1536x1024"),
        other => other,
    }
}

fn is_gpt_image_model(model: &str) -> bool {
    // Covers gpt-image-1, gpt-image-1.5, gpt-image-2, gpt-image-2-2026-04-21, …
    model.starts_with("gpt-image")
}

fn build_image_request<'a>(
    provider_id: &str,
    model: &'a str,
    prompt: &'a str,
    opts: &'a ImageOpts,
) -> ImageRequest<'a> {
    let (size, aspect_ratio, resolution, width, height, n, quality) = match provider_id {
        "openai" => {
            // Default quality to medium for GPT image models: high/auto regularly
            // exceeds 3 minutes and our previous 180s timeout, so generations
            // appeared to hang forever. medium is ~60–90s for 1024².
            let gpt_image = is_gpt_image_model(model);
            let size = if gpt_image {
                openai_gpt_image_size(opts.size.as_deref())
            } else {
                opts.size.as_deref()
            };
            let quality = if gpt_image { Some("medium") } else { None };
            (size, None, None, None, None, opts.n.or(Some(1)), quality)
        }
        "xai" => {
            let (aspect_ratio, resolution) = xai_image_dimensions(opts.size.as_deref());
            (
                None,
                aspect_ratio,
                resolution,
                None,
                None,
                opts.n.or(Some(1)),
                None,
            )
        }
        "together" if model == "black-forest-labs/FLUX.1-schnell-Free" => {
            let (aspect_ratio, _) = xai_image_dimensions(opts.size.as_deref());
            (
                None,
                aspect_ratio,
                None,
                None,
                None,
                opts.n.or(Some(1)),
                None,
            )
        }
        "together" if model == "black-forest-labs/FLUX.1-pro" => {
            let (width, height) = image_pixel_dimensions(opts.size.as_deref());
            (None, None, None, width, height, opts.n.or(Some(1)), None)
        }
        _ => (None, None, None, None, None, None, None),
    };
    ImageRequest {
        model,
        prompt,
        size,
        aspect_ratio,
        resolution,
        width,
        height,
        n,
        quality,
    }
}

/// SSRF guard for the image-fetch fallback path. Rejects anything that isn't
/// a parseable `https://` URL with a non-empty host. We deliberately do NOT
/// allow `http://` here — image-gen providers are uniformly TLS, and an
/// `http://` redirect target almost always indicates a compromised /
/// misconfigured upstream.
fn validate_image_url(s: &str) -> Result<(), AiError> {
    let parsed = url::Url::parse(s)
        .map_err(|e| AiError::ProviderError(format!("image: invalid URL {s}: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(AiError::ProviderError(format!(
            "image: refusing non-HTTPS URL: scheme={}",
            parsed.scheme()
        )));
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err(AiError::ProviderError(
            "image: URL has empty host".to_string(),
        ));
    }
    Ok(())
}

/// Magic-byte sniff so a non-image response (e.g. an HTML error page from a
/// CDN) doesn't propagate to callers as "PNG bytes". Recognises the four
/// formats the rest of the app handles (PNG, JPEG, WEBP, GIF). Anything else
/// is rejected as `ProviderError` rather than silently returned.
fn validate_image_bytes(bytes: &[u8]) -> Result<(), AiError> {
    if bytes.len() < 12 {
        return Err(AiError::ProviderError(
            "image: response too short to be a valid image".to_string(),
        ));
    }
    let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    let is_jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
    let is_gif = bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a");
    // WEBP: "RIFF" then 4 byte size then "WEBP".
    let is_webp = bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
    if is_png || is_jpeg || is_gif || is_webp {
        Ok(())
    } else {
        Err(AiError::ProviderError(
            "image: response did not match any supported image format (PNG/JPEG/WEBP/GIF)"
                .to_string(),
        ))
    }
}

#[async_trait]
impl AIProvider for OpenAICompatibleProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn embedding_model_id(&self) -> &str {
        &self.embedding_model
    }

    fn chat_model_id(&self) -> &str {
        &self.chat_model
    }

    fn endpoint_host(&self) -> String {
        url::Url::parse(&self.endpoint)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_else(|| "unknown".into())
    }

    fn endpoint_class(&self) -> EndpointClass {
        classify_endpoint(&self.endpoint)
    }

    fn set_usage_sink(&self, slot: TokenUsageSlot) {
        if let Ok(mut guard) = self.usage_sink.write() {
            // Clear any stale data in the new slot before registering it.
            if let Ok(mut s) = slot.lock() {
                *s = None;
            }
            *guard = Some(slot);
        }
    }

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/embeddings", self.endpoint);
        let body = EmbeddingsRequest {
            model: &self.embedding_model,
            input: texts,
        };
        let resp = self
            .client
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                AiError::ProviderError(self.scrub(format!("embed request failed: {e}")))
            })?;

        let bytes = self.handle_status(resp).await?;
        let parsed: EmbeddingsResponse = serde_json::from_slice(&bytes).map_err(|e| {
            AiError::ProviderError(self.scrub(format!("embed JSON parse failed: {e}")))
        })?;

        // Capture token usage from the response (if available) before consuming `parsed`.
        let (prompt_tokens, completion_tokens) = parsed
            .usage
            .as_ref()
            .map(|u| (u.prompt_tokens, u.completion_tokens))
            .unwrap_or((None, None));

        if parsed.data.len() != texts.len() {
            return Err(AiError::ProviderError(format!(
                "embed: expected {} vectors, got {}",
                texts.len(),
                parsed.data.len()
            )));
        }

        // Some providers return data in arbitrary order with `index`
        // populated; OpenAI reliably sends ascending. Sort by `index` if
        // any datum carries it, otherwise trust positional order.
        let mut data = parsed.data;
        if data.iter().any(|d| d.index.is_some()) {
            data.sort_by_key(|d| d.index.unwrap_or(usize::MAX));
        }

        // Validate dim consistency across the batch — a provider returning
        // a ragged batch is a contract violation we should surface eagerly,
        // not paper over with `[0u8; dim]` padding.
        let first_dim = data
            .first()
            .map(|d| d.embedding.len())
            .ok_or_else(|| AiError::ProviderError("embed: empty response".into()))?;
        if first_dim == 0 {
            return Err(AiError::ProviderError(
                "embed: provider returned zero-dim vector".into(),
            ));
        }
        for (i, d) in data.iter().enumerate() {
            if d.embedding.len() != first_dim {
                return Err(AiError::ProviderError(format!(
                    "embed: dim mismatch at index {i}: expected {first_dim}, got {}",
                    d.embedding.len()
                )));
            }
        }

        // L2-normalise. Some providers (notably Ollama for some models)
        // don't pre-normalise; downstream cosine-as-dot-product needs unit
        // vectors. The trait contract is "L2-unit out", so do it here.
        let mut out: Vec<Vec<f32>> = data.into_iter().map(|d| d.embedding).collect();
        for v in out.iter_mut() {
            crate::ai::embedder::l2_normalise_in_place(v);
        }

        // Write token usage just before returning.
        self.write_usage(prompt_tokens, completion_tokens);
        Ok(out)
    }

    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError> {
        let model = opts.model.as_deref().unwrap_or(&self.chat_model);
        let api_path = chat_api_path(self.is_openai_strict(), model);
        if api_path == "responses" {
            return self.chat_via_responses(messages, &opts, model).await;
        }

        let url = format!("{}/{api_path}", self.endpoint);
        let req_messages: Vec<ChatRequestMessage<'_>> = messages
            .iter()
            .map(|m| ChatRequestMessage {
                role: role_str(m.role),
                content: &m.content,
            })
            .collect();
        let body = build_chat_request(
            &self.id,
            self.is_openai_strict(),
            model,
            req_messages,
            &opts,
            false,
        );
        let resp = self
            .client
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::ProviderError(self.scrub(format!("chat request failed: {e}"))))?;
        let bytes = self.handle_status(resp).await?;
        let parsed: ChatResponse = serde_json::from_slice(&bytes).map_err(|e| {
            AiError::ProviderError(self.scrub(format!("chat JSON parse failed: {e}")))
        })?;

        // Capture token usage before consuming `parsed`.
        let (prompt_tokens, completion_tokens) = parsed
            .usage
            .as_ref()
            .map(|u| (u.prompt_tokens, u.completion_tokens))
            .unwrap_or((None, None));

        let content = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| {
                AiError::ProviderError("chat: response had no choices[0].message.content".into())
            })?;

        // Write token usage just before returning.
        self.write_usage(prompt_tokens, completion_tokens);
        Ok(content)
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        let url = format!("{}/chat/completions", self.endpoint);
        let model = opts.model.as_deref().unwrap_or(&self.chat_model);
        let req_messages: Vec<ChatRequestMessage<'_>> = messages
            .iter()
            .map(|m| ChatRequestMessage {
                role: role_str(m.role),
                content: &m.content,
            })
            .collect();
        let body = build_chat_request(
            &self.id,
            self.is_openai_strict(),
            model,
            req_messages,
            &opts,
            true,
        );
        if !body.stream {
            drop(body);
            let result = tokio::select! {
                _ = cancel.cancelled() => return Err(AiError::Cancelled),
                result = self.chat(messages, opts) => result,
            };
            let content = result?;
            return tokio::select! {
                _ = cancel.cancelled() => Err(AiError::Cancelled),
                sent = tx.send(content) => {
                    if sent.is_err() {
                        Err(AiError::Cancelled)
                    } else {
                        Ok(())
                    }
                }
            };
        }
        // Race the connection-establishment phase against the cancel
        // token — the user might dismiss before the first byte lands.
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            r = self
                .client
                .post(&url)
                .headers(self.auth_headers())
                .json(&body)
                .send() => r.map_err(|e| {
                    AiError::ProviderError(self.scrub(format!("chat stream request failed: {e}")))
                })?,
        };

        let status = resp.status();
        if !status.is_success() {
            // Reuse the same status mapping as the non-streaming path.
            // 401/403 → AuthFailed, 429 → RateLimited, else ProviderError.
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(AiError::AuthFailed);
            }
            if status.as_u16() == 429 {
                return Err(AiError::RateLimited);
            }
            let body = resp.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(512).collect();
            return Err(AiError::ProviderError(
                self.scrub(format!("HTTP {status}: {snippet}")),
            ));
        }

        // Stream the SSE body. Each `data: <json>\n\n` chunk carries
        // one delta; the final marker is the literal string `[DONE]`.
        // We accumulate bytes until we see `\n\n` because chunks may
        // straddle TCP packet boundaries.
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut total_bytes: usize = 0;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err(AiError::Cancelled),
                next = stream.next() => {
                    let chunk = match next {
                        Some(Ok(c)) => c,
                        Some(Err(e)) => {
                            return Err(AiError::ProviderError(
                                self.scrub(format!("chat stream read failed: {e}")),
                            ));
                        }
                        None => break,
                    };
                    total_bytes += chunk.len();
                    if total_bytes > MAX_RESPONSE_BYTES {
                        return Err(AiError::ProviderError(format!(
                            "chat stream exceeded {MAX_RESPONSE_BYTES} bytes"
                        )));
                    }
                    buf.extend_from_slice(&chunk);
                    // Drain every complete SSE event (`\n\n` delimited).
                    for event in drain_sse_events(&mut buf) {
                        if let Some(payload) = parse_sse_data(&event) {
                            if payload.trim() == "[DONE]" {
                                return Ok(());
                            }
                            // Skip empty payloads (some providers send
                            // keep-alive `:` comments before the first
                            // real chunk).
                            if payload.trim().is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<ChatStreamChunk>(&payload) {
                                Ok(parsed) => {
                                    // Token usage arrives in the final
                                    // pre-`[DONE]` chunk (when the request
                                    // set `stream_options.include_usage`).
                                    // That chunk's `choices` is typically
                                    // empty, so check `usage` independently
                                    // of content extraction.
                                    if let Some(usage) = parsed.usage.as_ref() {
                                        self.write_usage(
                                            usage.prompt_tokens,
                                            usage.completion_tokens,
                                        );
                                    }
                                    if let Some(content) = parsed
                                        .choices
                                        .into_iter()
                                        .next()
                                        .and_then(|c| c.delta.content)
                                    {
                                        if !content.is_empty() {
                                            // If the receiver dropped, abort the stream.
                                            if tx.send(content).await.is_err() {
                                                return Err(AiError::Cancelled);
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[ai] chat_stream: skipping malformed SSE chunk: {e}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
        let model = opts
            .model
            .as_deref()
            .or(self.image_model.as_deref())
            .ok_or_else(|| {
                AiError::ProviderUnsupported(
                    "image generation not configured for this provider".into(),
                )
            })?;
        let url = format!("{}/images/generations", self.endpoint);
        let body = build_image_request(&self.id, model, prompt, &opts);
        let resp = self
            .image_client
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                AiError::ProviderError(self.scrub(format!("image request failed: {e}")))
            })?;
        let bytes = self.handle_status(resp).await?;
        let parsed: ImageResponse = serde_json::from_slice(&bytes).map_err(|e| {
            AiError::ProviderError(self.scrub(format!("image JSON parse failed: {e}")))
        })?;
        let datum = parsed
            .data
            .into_iter()
            .next()
            .ok_or_else(|| AiError::ProviderError("image: empty data array".into()))?;

        // Two response shapes per upstream:
        //   - OpenAI default → `b64_json`
        //   - DALL-E w/ `response_format=url` → `url`
        // We prefer base64 (one round-trip, no second fetch leaking the
        // generated image URL into a CDN log) but fall back to URL.
        if let Some(b64) = datum.b64_json {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let bytes = STANDARD
                .decode(b64)
                .map_err(|e| AiError::ProviderError(format!("image base64 decode failed: {e}")))?;
            validate_image_bytes(&bytes)?;
            return Ok(bytes);
        }
        if let Some(image_url) = datum.url {
            // SSRF defence: only fetch from `https://` URLs. A malicious /
            // misconfigured upstream could otherwise redirect us to
            // `http://internal.example.com/secret` (the embed-side target
            // in the cf-review threat model).
            validate_image_url(&image_url)?;
            let img_resp = self
                .image_client
                .get(&image_url)
                .send()
                .await
                .map_err(|e| AiError::ProviderError(format!("image fetch failed: {e}")))?;
            let bytes = Self::bytes_with_cap(img_resp, MAX_IMAGE_BYTES).await?;
            validate_image_bytes(&bytes)?;
            return Ok(bytes);
        }
        Err(AiError::ProviderError(
            "image: response had neither url nor b64_json".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(endpoint: String, api_key: Option<String>) -> OpenAICompatibleConfig {
        OpenAICompatibleConfig {
            id: "test".into(),
            display_name: "Test".into(),
            endpoint,
            api_key: api_key.map(Zeroizing::new),
            chat_model: "test-chat".into(),
            embedding_model: "test-embed".into(),
            image_model: Some("test-image".into()),
        }
    }

    fn provider(endpoint: String, api_key: Option<String>) -> OpenAICompatibleProvider {
        OpenAICompatibleProvider::new(config(endpoint, api_key)).unwrap()
    }

    // ── embed ────────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn embed_single_input_returns_unit_vector() {
        let mock = MockServer::start().await;
        // Use a non-unit-norm body so we can verify the provider L2-normalises.
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [3.0_f32, 4.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let out = p.embed(&["hello"]).await.unwrap();
        assert_eq!(out.len(), 1);
        // [3, 4] / 5 = [0.6, 0.8] — unit norm.
        let norm: f32 = out[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_batch_preserves_order() {
        let mock = MockServer::start().await;
        // Provider returns indices out of order; impl must sort by `index`.
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [
                    { "embedding": [0.0_f32, 1.0_f32], "index": 1 },
                    { "embedding": [1.0_f32, 0.0_f32], "index": 0 },
                ]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let out = p.embed(&["a", "b"]).await.unwrap();
        assert_eq!(out.len(), 2);
        // After sort: index 0 = [1, 0], index 1 = [0, 1].
        assert!((out[0][0] - 1.0).abs() < 1e-5);
        assert!(out[0][1].abs() < 1e-5);
        assert!(out[1][0].abs() < 1e-5);
        assert!((out[1][1] - 1.0).abs() < 1e-5);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_dim_mismatch_returns_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [
                    { "embedding": [1.0_f32, 0.0_f32] },
                    { "embedding": [1.0_f32, 0.0_f32, 0.0_f32] },
                ]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p.embed(&["a", "b"]).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(s.contains("dim mismatch"), "got: {s}"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_count_mismatch_returns_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32] }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p.embed(&["a", "b"]).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(s.contains("expected 2 vectors"), "got: {s}"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_sends_bearer_when_key_set() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .and(header("authorization", "Bearer sk-secret-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-secret-123".into()));
        // Will only match (and 200) if header is sent.
        p.embed(&["x"]).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_omits_bearer_when_no_key() {
        // Local Ollama / llama-server commonly run unauthenticated. Provider
        // must NOT send any Authorization header in that case (some servers
        // 400 on empty bearer values).
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), None);
        p.embed(&["x"]).await.unwrap();
        // Inspect the captured request for absence of Authorization.
        let received = mock.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        assert!(received[0].headers.get("authorization").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_includes_model_in_payload() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .and(body_string_contains("test-embed"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        p.embed(&["x"]).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_propagates_429_as_rate_limited() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p.embed(&["x"]).await.unwrap_err();
        assert!(matches!(err, AiError::RateLimited), "got {err:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_propagates_401_as_auth_failed() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p.embed(&["x"]).await.unwrap_err();
        assert!(matches!(err, AiError::AuthFailed), "got {err:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_empty_input_returns_empty_vec() {
        let p = provider("http://127.0.0.1:1".into(), None);
        let out = p.embed(&[]).await.unwrap();
        assert!(out.is_empty());
    }

    // ── chat ─────────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn chat_returns_assistant_content() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [
                    { "message": { "role": "assistant", "content": "hello there" } }
                ]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let out = p.chat(&msgs, ChatOpts::default()).await.unwrap();
        assert_eq!(out, "hello there");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_propagates_429_as_rate_limited() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p.chat(&msgs, ChatOpts::default()).await.unwrap_err();
        assert!(matches!(err, AiError::RateLimited), "got {err:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_propagates_401_as_auth_failed() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(403).set_body_string("forbidden"))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p.chat(&msgs, ChatOpts::default()).await.unwrap_err();
        assert!(matches!(err, AiError::AuthFailed), "got {err:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_propagates_500_as_provider_error() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal"))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p.chat(&msgs, ChatOpts::default()).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(s.contains("500"), "got {s}"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_handles_missing_choices() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": []
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p.chat(&msgs, ChatOpts::default()).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(s.contains("choices"), "got {s}"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_uses_explicit_model_override() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_string_contains("custom-model-override"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "ok" } }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let opts = ChatOpts {
            model: Some("custom-model-override".into()),
            ..Default::default()
        };
        let out = p.chat(&msgs, opts).await.unwrap();
        assert_eq!(out, "ok");
    }

    // ── reasoning_effort: "none" (Ollama Qwen3.5 / GPT-OSS thinking-model fix) ──

    #[tokio::test(flavor = "current_thread")]
    async fn chat_ollama_disables_reasoning_effort() {
        // Reasoning models (Qwen 3.5, GPT-OSS, DeepSeek-R1) burn the entire
        // max_tokens budget on the `reasoning` channel and return empty
        // `content` — the call ends up firing AI_EMPTY_RESPONSE in
        // stream_chat_with_fallback. Sending `reasoning_effort:"none"`
        // (per Ollama's OpenAI-compat docs) suppresses that channel and
        // forces the model to spend tokens on the user-visible answer.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_string_contains("\"reasoning_effort\":\"none\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "ok" } }]
            })))
            .mount(&mock)
            .await;

        let mut cfg = config(mock.uri(), Some("sk-test".into()));
        cfg.id = "ollama".into();
        let p = OpenAICompatibleProvider::new(cfg).unwrap();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let out = p.chat(&msgs, ChatOpts::default()).await.unwrap();
        assert_eq!(out, "ok");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_ollama_sends_max_tokens_and_reasoning_effort() {
        // Ollama needs `reasoning_effort:"none"` to keep
        // thinking models (Qwen 3.x, GPT-OSS, DeepSeek-R1) from burning the
        // token budget on the reasoning channel and returning empty content.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_string_contains("\"reasoning_effort\":\"none\""))
            .and(body_string_contains("\"max_tokens\":"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
                         data: [DONE]\n\n",
                    ),
            )
            .mount(&mock)
            .await;

        let mut cfg = config(mock.uri(), Some("sk-test".into()));
        cfg.id = "ollama".into();
        let p = OpenAICompatibleProvider::new(cfg).unwrap();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let opts = ChatOpts {
            max_tokens: Some(2000),
            ..Default::default()
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        p.chat_stream(&msgs, opts, tx, cancel).await.unwrap();
        let mut acc = String::new();
        while let Some(d) = rx.recv().await {
            acc.push_str(&d);
        }
        assert_eq!(acc, "hi");
    }

    #[test]
    fn is_openai_strict_matches_official_host_only() {
        // Exact host match.
        assert!(provider("https://api.openai.com/v1".into(), None).is_openai_strict());
        // Trailing slash and v1 prefix don't matter — endpoint is normalised.
        assert!(provider("https://api.openai.com".into(), None).is_openai_strict());
        // Subdomains under api.openai.com (e.g. azure-fronted shims) count.
        assert!(provider("https://eu.api.openai.com/v1".into(), None).is_openai_strict());
        // Loose dialect for everything else.
        assert!(!provider("http://127.0.0.1:11434/v1".into(), None).is_openai_strict());
        assert!(!provider("https://openrouter.ai/api/v1".into(), None).is_openai_strict());
        assert!(!provider("https://api.anthropic.com/v1".into(), None).is_openai_strict());
        // Anti-spoof: a hostname that merely contains `api.openai.com` as a
        // suffix-of-a-label must NOT match.
        assert!(!provider("https://notapi.openai.com/v1".into(), None).is_openai_strict());
        assert!(!provider("https://api.openai.com.evil.com/v1".into(), None).is_openai_strict());
    }

    #[test]
    fn chat_stream_strict_dialect_uses_max_completion_tokens_and_omits_reasoning_effort() {
        // Official OpenAI GPT-5.x models reject
        // `max_tokens` with HTTP 400 `unsupported_parameter`. They also use a
        // different `reasoning_effort` vocabulary (minimal/low/medium/high,
        // plus `none` confirmed on GPT-5.5+) — the policy omits the
        // field for GPT-5.4-and-below and sends `"none"` for GPT-5.5+, gated
        // by `openai_supports_reasoning_none`. GPT-5.x still streams via
        // `delta.content` regardless of the reasoning channel state.
        let opts = ChatOpts {
            temperature: Some(0.7),
            max_tokens: Some(2000),
            ..Default::default()
        };
        let make_body = |model: &'static str| {
            build_chat_request(
                "openai",
                true,
                model,
                vec![ChatRequestMessage {
                    role: "user",
                    content: "hi",
                }],
                &opts,
                true,
            )
        };

        // GPT-5.4 can use its own default, so the field remains omitted.
        let body = make_body("gpt-5.4-mini");
        let json = serde_json::to_string(&body).unwrap();
        assert!(
            json.contains("\"max_completion_tokens\":2000"),
            "strict dialect must serialise max_completion_tokens; got {json}"
        );
        assert!(
            !json.contains("\"max_tokens\""),
            "strict dialect must NOT serialise max_tokens; got {json}"
        );
        assert!(
            !json.contains("\"reasoning_effort\""),
            "gpt-5.4 must omit reasoning_effort; got {json}"
        );

        // GPT-5.5+: accepts "none" and disabling it is the whole point of
        // this feature — must be present.
        let body = make_body("gpt-5.5");
        let json = serde_json::to_string(&body).unwrap();
        assert!(
            json.contains("\"reasoning_effort\":\"none\""),
            "gpt-5.5 must send reasoning_effort:none; got {json}"
        );
    }

    #[test]
    fn openai_supports_reasoning_none_matches_gpt_5_5_plus_only() {
        // Positive: GPT-5.5 tier (with suffixes) and the bare GPT-5.6
        // prefix. GPT-5.6 ships as named variants ("Sol"/"Terra"/"Luna"),
        // not a `-mini`/`-pro`/`-nano` suffix scheme — those specific IDs
        // are confirmed NOT to exist, so this test doesn't assert on a
        // fabricated one; the bare prefix is enough to prove the match.
        assert!(openai_supports_reasoning_none("gpt-5.5"));
        assert!(openai_supports_reasoning_none("gpt-5.6"));

        // Negative: GPT-5.4 and below (unconfirmed support, so the safe
        // default omits the field), non-GPT-5.x families, and one step
        // past the intended range to document the fail-safe direction.
        assert!(!openai_supports_reasoning_none("gpt-5.4"));
        assert!(!openai_supports_reasoning_none("gpt-5"));
        assert!(!openai_supports_reasoning_none("gpt-5-mini"));
        assert!(!openai_supports_reasoning_none("gpt-5.5-pro"));
        assert!(!openai_supports_reasoning_none("gpt-5.5-pro-2026-04-23"));
        assert!(!openai_supports_reasoning_none("gpt-4.1"));
        assert!(!openai_supports_reasoning_none("gpt-4o"));
        assert!(!openai_supports_reasoning_none("o3"));
        assert!(!openai_supports_reasoning_none("gpt-5.7"));
        // Case-sensitive: a mistyped model string falls through to the
        // safe "omit" branch rather than matching.
        assert!(!openai_supports_reasoning_none("GPT-5.5"));
    }

    #[test]
    fn gpt_5_mini_uses_minimal_reasoning_to_preserve_output_budget() {
        let opts = ChatOpts {
            temperature: Some(0.4),
            max_tokens: Some(1500),
            ..Default::default()
        };
        for model in ["gpt-5-mini", "gpt-5-mini-2025-08-07"] {
            let body = build_chat_request(
                "openai",
                true,
                model,
                vec![ChatRequestMessage {
                    role: "user",
                    content: "Generate themes",
                }],
                &opts,
                false,
            );

            let json = serde_json::to_string(&body).unwrap();
            assert!(
                json.contains("\"reasoning_effort\":\"minimal\""),
                "{model} must use minimal reasoning so the completion cap leaves room for content; got {json}"
            );
        }

        let near_miss = build_chat_request(
            "openai",
            true,
            "gpt-5-minimal",
            vec![ChatRequestMessage {
                role: "user",
                content: "Generate themes",
            }],
            &opts,
            false,
        );
        assert!(
            near_miss.reasoning_effort.is_none(),
            "near-miss model IDs must not receive GPT-5 mini parameters"
        );
    }

    #[test]
    fn gpt_5_5_pro_disables_unsupported_streaming() {
        let opts = ChatOpts {
            max_tokens: Some(1500),
            ..Default::default()
        };
        for model in ["gpt-5.5-pro", "gpt-5.5-pro-2026-04-23"] {
            let body = build_chat_request(
                "openai",
                true,
                model,
                vec![ChatRequestMessage {
                    role: "user",
                    content: "hi",
                }],
                &opts,
                true,
            );

            assert!(!body.stream, "{model} must not request streaming");
            assert!(
                body.stream_options.is_none(),
                "{model} must not send stream_options"
            );
        }
    }

    #[test]
    fn gpt_5_5_pro_uses_responses_api_wire_shape() {
        assert_eq!(chat_api_path(true, "gpt-5.5-pro"), "responses");
        assert_eq!(chat_api_path(true, "gpt-5.5-pro-2026-04-23"), "responses");
        assert_eq!(
            chat_api_path(false, "gpt-5.5-pro"),
            "chat/completions",
            "compatible endpoints must retain their own dialect"
        );
        assert_eq!(chat_api_path(true, "gpt-5.5"), "chat/completions");

        let opts = ChatOpts {
            temperature: Some(0.4),
            max_tokens: Some(1500),
            ..Default::default()
        };
        let body = build_responses_request(
            "gpt-5.5-pro",
            vec![ChatRequestMessage {
                role: "user",
                content: "Generate themes",
            }],
            &opts,
        );

        assert_eq!(
            serde_json::to_value(body).unwrap(),
            serde_json::json!({
                "model": "gpt-5.5-pro",
                "input": [{ "role": "user", "content": "Generate themes" }],
                "max_output_tokens": 8192,
                "reasoning": { "effort": "medium" },
                "store": false
            })
        );
    }

    #[test]
    fn responses_api_extracts_output_text_while_ignoring_reasoning_items() {
        let parsed: ResponsesResponse = serde_json::from_value(serde_json::json!({
            "output": [
                { "type": "reasoning", "content": [] },
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "{\"themes\":[]}" }
                    ]
                }
            ],
            "usage": { "input_tokens": 120, "output_tokens": 45 }
        }))
        .unwrap();

        assert_eq!(
            responses_output_text(&parsed).unwrap().as_deref(),
            Some("{\"themes\":[]}")
        );
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(120));
        assert_eq!(usage.output_tokens, Some(45));
    }

    #[test]
    fn responses_api_surfaces_incomplete_output_instead_of_empty_content() {
        let parsed: ResponsesResponse = serde_json::from_value(serde_json::json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": []
        }))
        .unwrap();

        let err = responses_output_text(&parsed).unwrap_err();
        match err {
            AiError::ProviderError(message) => {
                assert!(message.contains("incomplete"));
                assert!(message.contains("max_output_tokens"));
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn responses_api_posts_private_request_and_captures_usage() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(body_string_contains("\"store\":false"))
            .and(body_string_contains("\"max_output_tokens\":8192"))
            .and(body_string_contains("\"effort\":\"medium\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "themes" }]
                }],
                "usage": { "input_tokens": 120, "output_tokens": 45 }
            })))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let usage: crate::ai::audit::TokenUsageSlot =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        p.set_usage_sink(usage.clone());
        let messages = vec![Message {
            role: MessageRole::User,
            content: "Generate themes".into(),
        }];

        let output = p
            .chat_via_responses(
                &messages,
                &ChatOpts {
                    max_tokens: Some(1500),
                    ..Default::default()
                },
                "gpt-5.5-pro",
            )
            .await
            .unwrap();

        assert_eq!(output, "themes");
        let usage = usage.lock().unwrap().clone().unwrap();
        assert_eq!(usage.tokens_in, Some(120));
        assert_eq!(usage.tokens_out, Some(45));
    }

    #[test]
    fn build_chat_request_matches_curated_provider_model_wire_policy() {
        let opts = ChatOpts {
            temperature: Some(0.4),
            max_tokens: Some(256),
            ..Default::default()
        };
        let make_body = |provider_id, official_openai, model: &'static str, stream| {
            build_chat_request(
                provider_id,
                official_openai,
                model,
                vec![ChatRequestMessage {
                    role: "user",
                    content: "hi",
                }],
                &opts,
                stream,
            )
        };

        let cases = [
            (
                "ollama",
                false,
                "qwen3.5:4b",
                true,
                Some("none"),
                true,
                false,
            ),
            (
                "ollama",
                false,
                "gemma4:e4b",
                true,
                Some("none"),
                true,
                false,
            ),
            ("lmstudio", false, "user-model", true, None, true, false),
            (
                "llama-server",
                false,
                "user-model",
                true,
                None,
                false,
                false,
            ),
            (
                "other-local",
                false,
                "user-model",
                false,
                None,
                false,
                false,
            ),
            (
                "on-device-llm",
                false,
                "gemma-4-e4b-it",
                true,
                None,
                false,
                false,
            ),
            (
                "openai",
                true,
                "gpt-5-mini",
                false,
                Some("minimal"),
                true,
                true,
            ),
            ("openai", true, "gpt-5.5", false, Some("none"), true, true),
            ("openai", true, "gpt-5.5-pro", false, None, false, true),
            ("openai", false, "gpt-5.5", false, None, false, false),
            (
                "anthropic",
                false,
                "claude-haiku-4-5",
                true,
                None,
                true,
                false,
            ),
            (
                "anthropic",
                false,
                "claude-sonnet-5-20260701",
                false,
                None,
                true,
                false,
            ),
            (
                "anthropic",
                false,
                "claude-sonnet-5",
                false,
                None,
                true,
                false,
            ),
            (
                "anthropic",
                false,
                "claude-opus-5",
                false,
                None,
                true,
                false,
            ),
            (
                "anthropic",
                false,
                "claude-opus-4-7-20260701",
                false,
                None,
                true,
                false,
            ),
            (
                "anthropic",
                false,
                "claude-opus-4-8",
                false,
                None,
                true,
                false,
            ),
            (
                "gemini",
                false,
                "gemini-3.6-flash",
                true,
                None,
                false,
                false,
            ),
            (
                "gemini",
                false,
                "gemini-3.1-pro-preview",
                true,
                None,
                false,
                false,
            ),
            (
                "gemini",
                false,
                "gemini-3.1-flash-lite",
                true,
                None,
                false,
                false,
            ),
            ("xai", false, "grok-4.5", true, None, true, false),
            (
                "openrouter",
                false,
                "meta-llama/llama-3.3-70b-instruct",
                true,
                None,
                true,
                false,
            ),
            (
                "openrouter",
                false,
                "anthropic/claude-haiku-4-5",
                true,
                None,
                true,
                false,
            ),
            (
                "together",
                false,
                "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
                true,
                None,
                false,
                false,
            ),
            (
                "together",
                false,
                "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                true,
                None,
                false,
                false,
            ),
            (
                "groq",
                false,
                "llama-3.1-8b-instant",
                true,
                None,
                true,
                false,
            ),
            (
                "groq",
                false,
                "llama-3.3-70b-versatile",
                true,
                None,
                true,
                false,
            ),
            ("custom", false, "user-model", false, None, false, false),
            (
                "unknown-provider",
                false,
                "user-model",
                false,
                None,
                false,
                false,
            ),
        ];

        for (
            provider_id,
            official_openai,
            model,
            sends_temperature,
            reasoning_effort,
            sends_stream_usage,
            uses_completion_tokens,
        ) in cases
        {
            for stream in [false, true] {
                let actual =
                    serde_json::to_value(make_body(provider_id, official_openai, model, stream))
                        .unwrap();
                let mut expected = serde_json::json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "hi" }],
                });
                let object = expected.as_object_mut().unwrap();
                if sends_temperature {
                    object.insert("temperature".into(), serde_json::to_value(0.4_f32).unwrap());
                }
                let sends_token_limit =
                    !matches!(provider_id, "custom" | "other-local" | "unknown-provider")
                        && (provider_id != "openai" || official_openai);
                if sends_token_limit {
                    if uses_completion_tokens {
                        object.insert("max_completion_tokens".into(), serde_json::json!(256));
                    } else {
                        object.insert("max_tokens".into(), serde_json::json!(256));
                    }
                }
                if let Some(reasoning_effort) = reasoning_effort {
                    object.insert(
                        "reasoning_effort".into(),
                        serde_json::json!(reasoning_effort),
                    );
                }
                let streams = stream && model != "gpt-5.5-pro";
                if streams {
                    object.insert("stream".into(), serde_json::json!(true));
                    if sends_stream_usage {
                        object.insert(
                            "stream_options".into(),
                            serde_json::json!({ "include_usage": true }),
                        );
                    }
                }
                assert_eq!(
                    actual, expected,
                    "unexpected {provider_id}/{model} request for stream={stream}"
                );
            }
        }
    }

    // ── network error ────────────────────────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn network_error_maps_to_provider_error() {
        // Port 1 is universally reserved + has nothing listening on Tauri test
        // hosts; a connect there fails immediately rather than timing out.
        let p = provider("http://127.0.0.1:1".into(), Some("sk-test".into()));
        let err = p.embed(&["x"]).await.unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)), "got {err:?}");
    }

    // ── image gen ────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn generate_image_unsupported_returns_provider_unsupported() {
        // Build a config with no image_model — generate_image must short-circuit.
        let cfg = OpenAICompatibleConfig {
            id: "test".into(),
            display_name: "Test".into(),
            endpoint: "http://127.0.0.1:1".into(),
            api_key: None,
            chat_model: "c".into(),
            embedding_model: "e".into(),
            image_model: None,
        };
        let p = OpenAICompatibleProvider::new(cfg).unwrap();
        let err = p
            .generate_image("a kitten", ImageOpts::default())
            .await
            .unwrap_err();
        assert!(
            matches!(err, AiError::ProviderUnsupported(_)),
            "got {err:?}"
        );
    }

    /// Minimum-viable bytes for each magic-byte sniff in
    /// `validate_image_bytes`. Used by the image-gen tests so the
    /// post-decode validation accepts our fixture.
    fn fake_png_bytes() -> Vec<u8> {
        // PNG signature + a few padding bytes (need >= 12 total).
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(b"padding-data");
        v
    }

    #[tokio::test(flavor = "current_thread")]
    async fn generate_image_decodes_b64_response() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let png = fake_png_bytes();
        let b64 = STANDARD.encode(&png);
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "b64_json": b64 }]
            })))
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some("sk-test".into()));
        let out = p
            .generate_image("a kitten", ImageOpts::default())
            .await
            .unwrap();
        assert_eq!(out, png);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn generate_image_maps_xai_sizes_to_aspect_ratio_and_resolution() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        for (size, aspect_ratio) in [
            ("1024x1024", "1:1"),
            ("1024x1792", "9:16"),
            ("1792x1024", "16:9"),
        ] {
            let png = fake_png_bytes();
            let b64 = STANDARD.encode(&png);
            let mock = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/images/generations"))
                .and(body_json(serde_json::json!({
                    "model": "grok-imagine-image-quality",
                    "prompt": "a kitten",
                    "aspect_ratio": aspect_ratio,
                    "resolution": "1k",
                    "n": 1,
                })))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [{ "b64_json": b64 }]
                })))
                .mount(&mock)
                .await;

            let mut cfg = config(mock.uri(), Some("sk-test".into()));
            cfg.id = "xai".into();
            cfg.image_model = Some("grok-imagine-image-quality".into());
            let p = OpenAICompatibleProvider::new(cfg).unwrap();
            let out = p
                .generate_image(
                    "a kitten",
                    ImageOpts {
                        size: Some(size.into()),
                        model: None,
                        n: Some(1),
                    },
                )
                .await
                .unwrap();

            assert_eq!(out, png);
        }
    }

    #[test]
    fn build_image_request_matches_known_provider_wire_shapes() {
        let opts = ImageOpts {
            size: Some("1024x1792".into()),
            model: None,
            n: Some(1),
        };

        let serialize = |provider_id, model| {
            serde_json::to_value(build_image_request(provider_id, model, "a kitten", &opts))
                .unwrap()
        };

        assert_eq!(
            serialize("openai", "gpt-image-2"),
            serde_json::json!({
                "model": "gpt-image-2",
                "prompt": "a kitten",
                "size": "1024x1536",
                "n": 1,
                "quality": "medium",
            })
        );
        assert_eq!(
            serialize("xai", "grok-imagine-image-quality"),
            serde_json::json!({
                "model": "grok-imagine-image-quality",
                "prompt": "a kitten",
                "aspect_ratio": "9:16",
                "resolution": "1k",
                "n": 1,
            })
        );
        assert_eq!(
            serialize("together", "black-forest-labs/FLUX.1-schnell-Free"),
            serde_json::json!({
                "model": "black-forest-labs/FLUX.1-schnell-Free",
                "prompt": "a kitten",
                "aspect_ratio": "9:16",
                "n": 1,
            })
        );
        assert_eq!(
            serialize("together", "black-forest-labs/FLUX.1-pro"),
            serde_json::json!({
                "model": "black-forest-labs/FLUX.1-pro",
                "prompt": "a kitten",
                "width": 1024,
                "height": 1792,
                "n": 1,
            })
        );
        assert_eq!(
            serialize("custom", "user-model"),
            serde_json::json!({
                "model": "user-model",
                "prompt": "a kitten",
            })
        );

        // DALL·E-3 keeps the 1792 sizes and must NOT receive GPT-image quality.
        assert_eq!(
            serialize("openai", "dall-e-3"),
            serde_json::json!({
                "model": "dall-e-3",
                "prompt": "a kitten",
                "size": "1024x1792",
                "n": 1,
            })
        );

        // Square GPT-image keeps 1024x1024 + medium quality.
        let square = ImageOpts {
            size: Some("1024x1024".into()),
            model: None,
            n: Some(1),
        };
        assert_eq!(
            serde_json::to_value(build_image_request(
                "openai",
                "gpt-image-2",
                "a kitten",
                &square
            ))
            .unwrap(),
            serde_json::json!({
                "model": "gpt-image-2",
                "prompt": "a kitten",
                "size": "1024x1024",
                "n": 1,
                "quality": "medium",
            })
        );
    }

    // ── new tests for cf-review hardening ────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn generate_image_rejects_non_image_b64() {
        // Magic-byte sniff: an HTML error page returned in `b64_json` must be
        // rejected rather than passed through as PNG bytes.
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let html = b"<html><body>error</body></html>";
        let b64 = STANDARD.encode(html);
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "b64_json": b64 }]
            })))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p
            .generate_image("a kitten", ImageOpts::default())
            .await
            .unwrap_err();
        match err {
            AiError::ProviderError(s) => {
                assert!(s.contains("supported image format"), "got: {s}");
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn generate_image_rejects_http_url() {
        // SSRF defence: image-fetch fallback must reject `http://` URLs.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "url": "http://internal.example.com/secret" }]
            })))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p
            .generate_image("a kitten", ImageOpts::default())
            .await
            .unwrap_err();
        match err {
            AiError::ProviderError(s) => {
                assert!(s.contains("non-HTTPS"), "got: {s}");
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[test]
    fn validate_image_bytes_accepts_known_formats() {
        // PNG
        assert!(validate_image_bytes(&fake_png_bytes()).is_ok());
        // JPEG (FF D8 FF + filler)
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.extend_from_slice(b"jfif-filler");
        assert!(validate_image_bytes(&jpeg).is_ok());
        // GIF
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(b"trailing");
        assert!(validate_image_bytes(&gif).is_ok());
        // WEBP
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.extend_from_slice(b"trailer");
        assert!(validate_image_bytes(&webp).is_ok());
    }

    #[test]
    fn validate_image_bytes_rejects_html() {
        let html = b"<!DOCTYPE html>\n<html>error</html>";
        assert!(validate_image_bytes(html).is_err());
    }

    #[test]
    fn validate_image_bytes_rejects_short_input() {
        assert!(validate_image_bytes(&[0x89, b'P']).is_err());
    }

    #[test]
    fn validate_image_url_rejects_non_https() {
        assert!(validate_image_url("http://example.com/img.png").is_err());
        assert!(validate_image_url("file:///etc/passwd").is_err());
        assert!(validate_image_url("data:image/png;base64,xxx").is_err());
    }

    #[test]
    fn validate_image_url_accepts_https() {
        assert!(
            validate_image_url("https://oaidalleapiprodscus.blob.core.windows.net/x.png").is_ok()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bytes_with_cap_rejects_oversized_response() {
        // Wiremock returns a body with a real Content-Length (computed from
        // the body) — so a body of 100KB has Content-Length: 100000. With
        // cap=1KB, `bytes_with_cap` must reject during the
        // Content-Length pre-check (no streaming reads happen).
        let big_body = vec![b'x'; 100_000];
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/blob"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(big_body))
            .mount(&mock)
            .await;
        let url = format!("{}/blob", mock.uri());
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let err = OpenAICompatibleProvider::bytes_with_cap(resp, 1_000)
            .await
            .unwrap_err();
        match err {
            AiError::ProviderError(s) => {
                assert!(s.contains("too large"), "got: {s}");
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_handles_trailing_slash_endpoint() {
        // Regression: the trim_end_matches('/') in ::new() must keep the
        // wire URL stable whether the user supplied `/v1` or `/v1/`.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;
        // Append an extra trailing slash to the mock URI.
        let p = provider(format!("{}/", mock.uri()), Some("sk-test".into()));
        p.embed(&["x"]).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn embed_propagates_502_as_provider_error() {
        // Spot-check: 502/503 are 5xx and should map to ProviderError.
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let err = p.embed(&["x"]).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => assert!(s.contains("502"), "got {s}"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    // ── secret redaction ─────────────────────────────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn provider_error_redacts_api_key() {
        let mock = MockServer::start().await;
        // Echo the key back in the error body — simulates a misconfigured
        // upstream that leaks the bearer in its 5xx response. The provider
        // must scrub it before returning to the caller.
        let key = "sk-very-secret-key-12345";
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(
                ResponseTemplate::new(500)
                    .set_body_string(format!("Authorization Bearer {key} was rejected")),
            )
            .mount(&mock)
            .await;

        let p = provider(mock.uri(), Some(key.into()));
        let err = p.embed(&["x"]).await.unwrap_err();
        match err {
            AiError::ProviderError(s) => {
                assert!(!s.contains(key), "API key leaked into error: {s}");
                assert!(s.contains("<redacted>"), "expected scrub marker, got: {s}");
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn debug_format_does_not_leak_api_key() {
        // `Debug` impl is what panic backtraces / `log::warn!("{:?}")` invoke.
        let p = provider("http://127.0.0.1:1".into(), Some("sk-secret".into()));
        let s = format!("{p:?}");
        assert!(!s.contains("sk-secret"), "Debug leaked key: {s}");
        assert!(s.contains("<redacted>"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn config_debug_does_not_leak_api_key() {
        let cfg = config("http://127.0.0.1:1".into(), Some("sk-secret".into()));
        let s = format!("{cfg:?}");
        assert!(!s.contains("sk-secret"), "Config Debug leaked key: {s}");
        assert!(s.contains("<redacted>"));
    }

    // ─── R6 — SSE parsing helpers ───────────────────────────────────────────

    #[test]
    fn parse_sse_data_extracts_payload() {
        let event = "data: hello\n\n";
        assert_eq!(parse_sse_data(event).as_deref(), Some("hello"));
    }

    #[test]
    fn parse_sse_data_drops_optional_leading_space() {
        // Per SSE spec, ONE leading space after `:` is consumed.
        let event = "data:no-space\n\n";
        assert_eq!(parse_sse_data(event).as_deref(), Some("no-space"));
    }

    #[test]
    fn parse_sse_data_concatenates_multiple_data_lines() {
        let event = "data: line1\ndata: line2\n\n";
        assert_eq!(parse_sse_data(event).as_deref(), Some("line1\nline2"));
    }

    #[test]
    fn parse_sse_data_ignores_comment_lines() {
        let event = ": this is a keep-alive\ndata: payload\n\n";
        assert_eq!(parse_sse_data(event).as_deref(), Some("payload"));
    }

    #[test]
    fn parse_sse_data_returns_none_for_no_data() {
        let event = ": just a comment\n\n";
        assert!(parse_sse_data(event).is_none());
    }

    #[test]
    fn find_double_newline_handles_both_lf_and_crlf() {
        let lf = b"data: x\n\n";
        assert_eq!(find_double_newline(lf), Some(7));
        let crlf = b"data: x\r\n\r\n";
        assert!(find_double_newline(crlf).is_some());
        // No terminator yet.
        assert!(find_double_newline(b"data: incomplete").is_none());
    }

    #[test]
    fn find_double_newline_prefers_earliest_terminator() {
        // Mixed styles in one buffer: an earlier `\r\n\r\n` must win
        // over a later `\n\n`, or the two frames merge into one.
        let mut buf = b"data: a\r\n\r\ndata: b\n\n".to_vec();
        let events = drain_sse_events(&mut buf);
        let payloads: Vec<_> = events.iter().filter_map(|e| parse_sse_data(e)).collect();
        assert_eq!(payloads, ["a", "b"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_sse_events_handles_event_straddling_two_chunks() {
        // Split the stream mid-payload AND between the two `\n`s of a
        // terminator; parsed events must be identical to the unsplit case.
        let full: &[u8] = b"data: one\n\ndata: two\n\ndata: three\n\n";
        let mut unsplit = full.to_vec();
        let expected = drain_sse_events(&mut unsplit);
        assert_eq!(
            expected,
            ["data: one\n\n", "data: two\n\n", "data: three\n\n"]
        );
        assert!(unsplit.is_empty());

        // Chunk A ends mid-payload of event two; chunk B ends between
        // the `\n\n` of event three's terminator; chunk C is the rest.
        let (a, rest) = full.split_at(15); // "data: one\n\ndata"
        let (b, c) = rest.split_at(full.len() - 15 - 1); // ...through "data: three\n"
        let mut buf = Vec::new();
        let mut got = Vec::new();
        for chunk in [a, b, c] {
            buf.extend_from_slice(chunk);
            got.extend(drain_sse_events(&mut buf));
        }
        assert_eq!(got, expected);
        assert!(buf.is_empty());

        // Partial event stays buffered: after chunk A alone, only the
        // first event drains and the tail remains untouched.
        let mut buf = a.to_vec();
        assert_eq!(drain_sse_events(&mut buf), ["data: one\n\n"]);
        assert_eq!(buf, b"data");
    }

    #[test]
    fn drain_sse_events_handles_crlf_event_split_mid_terminator() {
        let full: &[u8] = b"data: x\r\n\r\ndata: y\r\n\r\n";
        let mut unsplit = full.to_vec();
        let expected = drain_sse_events(&mut unsplit);
        assert_eq!(expected, ["data: x\r\n\r\n", "data: y\r\n\r\n"]);

        // Chunk A ends inside the first `\r\n\r\n` terminator.
        let (a, b) = full.split_at(10); // "data: x\r\n\r"
        let mut buf = a.to_vec();
        assert!(drain_sse_events(&mut buf).is_empty());
        buf.extend_from_slice(b);
        assert_eq!(drain_sse_events(&mut buf), expected);
        assert!(buf.is_empty());
    }

    // ─── R6 — chat_stream end-to-end ───────────────────────────────────────

    /// Build a wiremock stream that emits SSE events from `events`,
    /// each terminated by `\n\n`, then `data: [DONE]\n\n`.
    fn sse_body(events: &[&str]) -> String {
        let mut out = String::new();
        for e in events {
            out.push_str("data: ");
            out.push_str(e);
            out.push_str("\n\n");
        }
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn delta_chunk(content: &str) -> String {
        serde_json::json!({
            "choices": [{ "delta": { "content": content } }]
        })
        .to_string()
    }

    /// Build an SSE chunk carrying ONLY a final `usage` payload (no
    /// `choices` content). Real OpenAI sends this as the last chunk
    /// before `[DONE]` when `stream_options.include_usage = true`.
    fn usage_chunk(prompt_tokens: u32, completion_tokens: u32) -> String {
        serde_json::json!({
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            }
        })
        .to_string()
    }

    /// Regression guard for the audit-log "—" tokens issue: when the
    /// provider streams a final `usage` chunk (because we now send
    /// `stream_options.include_usage = true`), `chat_stream` must write
    /// the token counts into the registered `TokenUsageSlot` so the
    /// `AuditingProvider` can record them.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_captures_token_usage_when_provider_reports_it() {
        let mock = MockServer::start().await;
        let body = sse_body(&[
            &delta_chunk("Hello"),
            &delta_chunk(" world"),
            &usage_chunk(123, 45),
        ]);
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_string_contains("\"stream\":true"))
            .and(body_string_contains("\"include_usage\":true"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&mock)
            .await;
        let mut cfg = config(mock.uri(), Some("sk-test".into()));
        cfg.id = "openrouter".into();
        let p = OpenAICompatibleProvider::new(cfg).unwrap();
        // Inject the audit slot that AuditingProvider would normally set.
        let slot: crate::ai::audit::TokenUsageSlot =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        p.set_usage_sink(slot.clone());

        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let stream = tauri::async_runtime::spawn(async move {
            p.chat_stream(&msgs, ChatOpts::default(), tx, cancel).await
        });
        // Drain the content channel so the SSE loop can finish.
        while rx.recv().await.is_some() {}
        stream.await.unwrap().unwrap();

        let usage = slot.lock().unwrap().clone().expect(
            "TokenUsageSlot was not populated; chat_stream did not parse the final usage chunk",
        );
        assert_eq!(usage.tokens_in, Some(123));
        assert_eq!(usage.tokens_out, Some(45));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_emits_tokens_in_order() {
        let mock = MockServer::start().await;
        let body = sse_body(&[
            &delta_chunk("Hello"),
            &delta_chunk(" "),
            &delta_chunk("world"),
        ]);
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_string_contains("\"stream\":true"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let stream = tauri::async_runtime::spawn(async move {
            p.chat_stream(&msgs, ChatOpts::default(), tx, cancel).await
        });
        let mut got = Vec::new();
        while let Some(t) = rx.recv().await {
            got.push(t);
        }
        stream.await.unwrap().unwrap();
        assert_eq!(got, vec!["Hello", " ", "world"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_skips_empty_delta_chunks() {
        let mock = MockServer::start().await;
        let empty = serde_json::json!({ "choices": [{ "delta": {} }] }).to_string();
        let body = sse_body(&[&empty, &delta_chunk("real")]);
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        tauri::async_runtime::spawn(async move {
            let _ = p.chat_stream(&msgs, ChatOpts::default(), tx, cancel).await;
        });
        let mut got = Vec::new();
        while let Some(t) = rx.recv().await {
            got.push(t);
        }
        assert_eq!(got, vec!["real"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_propagates_401_as_auth_failed() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let (tx, _rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p
            .chat_stream(&msgs, ChatOpts::default(), tx, cancel)
            .await
            .unwrap_err();
        assert!(matches!(err, AiError::AuthFailed));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_propagates_429_as_rate_limited() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&mock)
            .await;
        let p = provider(mock.uri(), Some("sk-test".into()));
        let (tx, _rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p
            .chat_stream(&msgs, ChatOpts::default(), tx, cancel)
            .await
            .unwrap_err();
        assert!(matches!(err, AiError::RateLimited));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_aborts_on_cancel_before_send() {
        // Cancel BEFORE the request even fires — the function must
        // observe and short-circuit. wiremock would otherwise hang.
        let p = provider("http://127.0.0.1:1".into(), None);
        let (tx, _rx) = tokio::sync::mpsc::channel::<String>(8);
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".into(),
        }];
        let err = p
            .chat_stream(&msgs, ChatOpts::default(), tx, cancel)
            .await
            .unwrap_err();
        assert!(matches!(err, AiError::Cancelled));
    }
}
