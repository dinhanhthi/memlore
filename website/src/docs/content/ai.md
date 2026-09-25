---
title: AI
description: How optional AI uses your journal, and what can leave this device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/ai/provider.rs, src-tauri/src/ai/providers/on_device_embed.rs, src-tauri/src/ai/providers/on_device_llm.rs, src-tauri/src/ai/on_device/catalog.rs, src-tauri/src/ai/on_device/llm_catalog.rs, src-tauri/src/commands/ai.rs, src-tauri/src/commands/ai_audit.rs, src-tauri/src/commands/ai_provider.rs, src-tauri/src/db/queries.rs, src-tauri/src/mcp/bridge.rs, src-tauri/src/mcp/lifecycle.rs, src/components/stats/AiAuditLogPanel.tsx
---

# AI

AI stays off until you choose a provider in Settings; there is no default company, and each feature can be turned off on its own.

:::widget ai-provider

## Where the request goes

:::cards

- **Integrated models** — Downloaded once, then run here. Your text stays on this computer.
- **A helper on this computer** — Such as Ollama. The request never leaves. No privacy notice.
- **A helper on your network** — Another computer gets your journal text, with **no** privacy notice. Any other address is treated like a cloud provider.
- **Cloud provider** — Such as OpenAI or Anthropic. After a privacy notice, it sees the text; Memlore cannot stop it keeping that text.
- **Claude or Codex program** — Uses your login, after that notice. Its company sees the text.

:::

## What each feature uses

- Writing help uses the entry you are writing, even a locked one you have open.
- Summaries, reviews, and chat skip locked entries.
- Meaning search sends passages as text; a switch can add locked entries, sent before you reveal them.
- Hidden entries are always left out, even from writing help. See [Locks](/docs/locks).
- Memories stay with a local helper unless you allow a hosted one. See [Memory](/docs/memory).

## Your key and the log

- Your API key stays encrypted on this device, not synced or sent to Memlore.
- The AI audit log records calls, not your journal text or key.

## Another app on this computer

- A local connection can let another app here read and write your journal.
- It stays off until you switch it on.
