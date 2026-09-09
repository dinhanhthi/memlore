# CLI Provider — JSON Stream Notes

Captured 2026-05-11 against:

- `claude --version` → 2.1.139 (Claude Code)
- `codex --version` → codex-cli 0.122.0

These notes drive the JSON parser switches in `claude.rs` and `codex.rs`. Update when bumping the minimum supported CLI version.

## Claude (`claude -p --output-format stream-json --verbose --include-partial-messages`)

### Invocation

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --no-session-persistence \
  --tools "" \
  --permission-mode dontAsk \
  --model sonnet \
  "<prompt>"
```

### Stream shape (filtered)

JSONL on stdout, one event per line:

1. `{"type":"system","subtype":"init", ...}` — session metadata. Includes `session_id`, `tools`, `model`, `apiKeySource`. **Skip in parser.**
2. `{"type":"system","subtype":"hook_started" | "hook_response", ...}` — Claude Code hook lifecycle. **Skip in parser** (cannot be disabled without `--bare`, which also disables OAuth/keychain → "Not logged in"). Always filter by `subtype.startsWith("hook_")`.
3. `{"type":"system","subtype":"status","status":"requesting", ...}` — informational. Skip.
4. `{"type":"stream_event","event":{"type":"message_start", ...}}` — assistant message begins.
5. `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}` — text block begins.
6. **`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"<token>"}}}` — THE token-delta event we forward.** Extract `event.delta.text` and send through `tx`.
7. `{"type":"assistant","message":{"content":[{"type":"text","text":"<full>"}], ...}}` — periodic full-message snapshot. Skip (we already streamed it).
8. `{"type":"stream_event","event":{"type":"content_block_stop"}}` — text block ends.
9. `{"type":"stream_event","event":{"type":"message_delta", ...usage...}}` — final usage stats.
10. `{"type":"stream_event","event":{"type":"message_stop"}}` — **terminal event** for the streaming-protocol level.
11. `{"type":"rate_limit_event","rate_limit_info":{...}}` — subscription rate-limit telemetry. Skip.
12. `{"type":"result","subtype":"success","is_error":false,"result":"<full text>", ...}` — **TRUE terminal event.** Always last. Parser bails on this.

### Auth-failure shape

When `claude auth status` is broken / not signed-in, the stream is short:

- `system|init` (apiKeySource: "none")
- `system|status: requesting`
- `assistant: {"content":[{"text":"Not logged in · Please run /login"}], "error":"authentication_failed"}`
- `result: {"is_error": true, "result":"Not logged in · Please run /login"}`

Detect by `result.is_error == true && result.result ~ /logged in|login/i` and map to `AiError::ProviderError("Claude CLI not signed in. Run \`claude /login\`.")`.

### `--bare` trap

`--bare` strips OAuth + keychain reads, so a subscription-only user gets "Not logged in" even when properly authenticated. **DO NOT use `--bare` in the provider.** Hook noise is filtered at the parser layer instead.

### `--tools ""` honored?

The `system|init` event always reports a non-empty `tools` array because user-config MCP servers are loaded regardless of `--tools ""`. However, the CLI does not actually grant access to those tools when `--tools ""` is passed — the array is just announced for visibility. (Tolaria uses the same pattern.)

**Runtime guard.** The parser additionally fails fast if any `tool_use` / `server_tool_use` / `tool_result` `content_block_start` event is emitted: drift in the CLI's `--tools ""` enforcement (a regression, a config override, a future flag) would otherwise let the model relay filesystem / network operations through Memlore. The user sees an `AiError::ProviderError("...Refusing to continue (privacy invariant)")` rather than a silently elided tool call.

### Parser pseudocode

```
on event:
  if event.type == "system" and event.subtype starts with "hook_": skip
  if event.type == "stream_event" and event.event.type == "content_block_delta":
      if event.event.delta.type == "text_delta":
          forward event.event.delta.text
  if event.type == "stream_event" and event.event.type == "thinking_delta": skip
  if event.type == "result":
      if event.is_error: error out with event.result
      else: terminate loop successfully
```

---

## Codex (`codex exec --json`)

### Invocation

```bash
codex exec --json \
  --skip-git-repo-check \
  --sandbox read-only \
  -c approval_policy=never \
  --ephemeral \
  --model gpt-5.4 \
  --output-last-message <tmp> \
  "<prompt>" </dev/null
```

### Critical flag corrections (vs initial plan)

- `--ask-for-approval` is **NOT** a valid flag on `codex exec` 0.122. Use `-c approval_policy=never` (TOML config override) instead.
- `--full-auto` is not appropriate either (it forces `workspace-write` sandbox).
- `codex exec` always reads stdin opportunistically and emits `Reading additional input from stdin...` to stderr. **Must redirect stdin to `/dev/null`** when spawning, otherwise the process blocks waiting for EOF.
- Default model from `~/.codex/config.toml` is `gpt-5.5`, which ChatGPT-account users may not have. Always pass an explicit `--model` (default: `gpt-5.4`).
- Model whitelist (from `~/.codex/models_cache.json`): `gpt-5.4` is the safe default for ChatGPT Plus accounts.

### Stream shape

Captured on 0.122.0, gpt-5.4, ChatGPT Plus account:

```
{"type":"thread.started","thread_id":"019e18e7-9927-7ad0-a349-da2202aa71ae"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi friend"}}
{"type":"turn.completed","usage":{"input_tokens":22896,"cached_input_tokens":3456,"output_tokens":57}}
```

**Key finding:** Codex 0.122 `--json` does NOT emit token-level deltas. The full agent reply arrives as a single `item.completed` event with `item.type == "agent_message"`.

### Implications for the provider

- We CANNOT do real token streaming with codex. The provider emits the full `item.completed.item.text` as a single delta when `item.type == "agent_message"`.
- The `--output-last-message <file>` is a redundant fallback (the file contains the same text). Keep it as a fallback ONLY for the case where no `agent_message` event appears (e.g. error mid-turn), so we can still surface SOMETHING.
- `thread.started`, `turn.started`, `turn.completed` — skip.
- `item.completed` with `item.type != "agent_message"` (e.g. `reasoning`, `command_executed`, `web_search_result`) — skip. We disabled tools via `--sandbox read-only` + `approval_policy=never` so reasoning is the only realistic non-message item.
- `error` and `turn.failed` events → map to `AiError::ProviderError(item.message)`.

### Parser pseudocode

```
let mut received_text = false;
on event:
  match event.type:
    "item.completed" if event.item.type == "agent_message":
        forward event.item.text
        received_text = true
    "error" | "turn.failed":
        error out with event.message
    "turn.completed":
        break loop
    _: skip
after loop (clean exit):
  if !received_text:
      read --output-last-message file; if non-empty, forward as single delta
```

### Auth-failure shape

`codex` exits non-zero with a stderr like `Error: not authenticated. Run \`codex login\`.` — surface via the existing non-zero-exit path with stderr excerpt. Detect "not authenticated" / "login" tokens to enrich the error message.

---

## Shared spawn invariants

- Stdin: write the prompt body (NOT including the model / system flags) and close stdin. The write is performed in a **concurrent background task** so the parent can start reading stdout immediately — a sequential write-then-read deadlocks once the prompt exceeds the pipe buffer (~16–64 KiB on macOS / Linux), because the CLI emits `system|init` + hook events to stdout _before_ it finishes reading the prompt. For codex specifically, even with a prompt arg the stdin must be closed (the writer task drops its end on completion).
- Stdout: line-buffered JSON. Read with `BufReader::lines()`. A malformed line MUST NOT abort the loop — log at debug and continue.
- Stderr: buffer up to `STDERR_CAP_BYTES` (16 KiB, see `runtime.rs`). Surface only on non-zero exit. On cancel, the drain task gets a `STDERR_DRAIN_GRACE` (100 ms) window to flush bytes already buffered before it's aborted — a grandchild that inherited the stderr fd would otherwise hold the read-end open indefinitely.
- Cancellation: on cancel, the **whole process group** is killed via `killpg` — `start_kill()` on a `tokio::process::Child` only signals the direct PID, but `claude` runs `node`/`bun` grandchildren that would survive a direct kill and keep burning subscription tokens. The child is spawned with `process_group(0)` (Unix) so it leads its own group; we `kill(-pgid, SIGTERM)` → `start_kill()` → `wait()` → `kill(-pgid, SIGKILL)`. `Drop` on `tokio::process::Child` does NOT kill — explicit kill required.
- PATH augmentation: prepend `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin`, the latest `~/.nvm/versions/node/*/bin`, `~/.volta/bin`. Needed because Tauri apps launched from Finder have a sparse PATH.
- Long prompts: stdin path handles arbitrary length on macOS. Windows path (later) can also use stdin.
