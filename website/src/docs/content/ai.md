---
title: AI
description: How optional AI uses your journal, and what can leave this device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/ai/provider.rs, src-tauri/src/ai/providers/on_device_embed.rs, src-tauri/src/ai/providers/on_device_llm.rs, src-tauri/src/ai/on_device/catalog.rs, src-tauri/src/ai/on_device/llm_catalog.rs, src-tauri/src/commands/ai.rs, src-tauri/src/commands/ai_audit.rs, src-tauri/src/commands/ai_provider.rs, src-tauri/src/db/queries.rs, src-tauri/src/mcp/bridge.rs, src-tauri/src/mcp/lifecycle.rs, src/components/stats/AiAuditLogPanel.tsx
---

# AI

AI is optional. Think of it as a note you hand to a helper you picked. That helper sees the note. It does not receive the rest of your journal, and Memlore has no server of its own in the middle.

## It stays off until you choose

Nothing runs until you choose a provider in Settings. There is no default company, and nothing is sent before that choice.

You can turn each feature off on its own. Until a provider is chosen, none of them run.

If the helper is on the internet, you accept a privacy notice first. The same notice applies to the Claude or Codex program on this computer, because that program sends the note on. A helper that stays on this machine does not ask for the notice. The request never leaves.

## What goes in the request

The helper sees the text of the request Memlore sends. That is the instruction, plus the writing you asked it to use. A cloud provider, such as OpenAI or Anthropic, sees that text. Memlore does not run that service and does not see the traffic.

Help on the entry you are writing uses that entry. A title, a highlight, a rewrite, or a continuation is a request about that page. Hidden entries are left out even then. A locked entry you have open can still be part of that one-page request.

Help across many entries is stricter. A summary, a review of a week or a month, or a chat that looks across a stretch of days is built only from entries that are not locked and not hidden. Locked entries and hidden entries are left out in the same way. [Locks](/docs/locks) explains those two hides.

After that filter, the path splits. On this computer, the request stays inside. A cloud provider you chose receives only that request.

:::diagram ai

Meaning search can use a separate helper. It sends passages as text so that helper can turn them into a short fingerprint of what they mean. By default, locked and hidden entries are skipped. A switch can include locked entries in those fingerprints. If that helper is in the cloud, their text is sent. Hidden entries stay out even then. Summaries, reviews, and chat across many entries still leave locked entries out.

The Claude and Codex programs are a third kind of helper. Memlore hands them the request on this computer. They send it on with your own login. Memlore never sees that login. The company behind the program still sees the text of the request.

Saved memories and a writing voice are described in [Memory](/docs/memory) and [Persona](/docs/persona). Memories stay with a helper on this machine unless you allow a hosted one.

## On this computer

Ollama, LM Studio, and llama.cpp's llama-server are programs you can run on this computer. When their address is on this computer, Memlore sends the request only there.

Integrated chat models download a model file once, check it, then run it here through llama-server. Integrated embedding models do the same kind of one-time download, then build those meaning fingerprints inside the app. After that download, your journal text stays on this machine for those jobs. The download is the model, not your writing.

If you type your own address, Memlore checks where it points. An address on this computer is local. So is a name that ends in .local, a private network address (one that starts with 10., 192.168., or 172.16. through 172.31.), or a private IPv6 address that starts with fc or fd. Those are not treated as a cloud provider, and the app does not ask for the privacy notice. The helper still receives the request. Ollama on another computer on your network is one case. Any other address is treated like a cloud provider. You accept the privacy notice, and that provider sees the request.

## Your key and the log

If a provider asks for an API key, Memlore stores it in the encrypted database on this device, scrambled so it is unreadable without your password. The key is not copied to your other devices. The app shows that a key is saved. It does not show the key itself, and it does not send the key to a Memlore server.

Memlore keeps a log of AI calls. You can read it in Statistics, on the AI audit log. Each line records which feature ran, which provider and model you used, and whether it worked. The log does not store your journal text or your key. If sync is on, the log is encrypted on this device before it is uploaded.

## What this means for you

- You choose the helper. Until you do, AI does not run.
- A cloud provider sees the text of the request you send. Memlore **cannot** see that traffic, and it **cannot** stop the provider from keeping the text under that provider's own rules.
- A helper on this computer keeps the request here. A helper on your own network can still receive the text, and the app does not ask for the privacy notice first. Integrated models stay on this computer. The one-time model download is not your journal.
- Locked and hidden entries are left out of summaries, reviews, and other features that read many entries at once. Hidden entries are left out of help on a single page too.
- A switch can send locked entries to a cloud helper when building search fingerprints. Hidden entries are never included in that.
- Your API key stays on this device.
- The AI log is a record of calls, not a copy of your writing.
- You can turn on a local connection so another app on this computer can read and write your journal. It stays off until you switch it on.

Nearby pages: [Locks](/docs/locks), [Memory](/docs/memory), and [Persona](/docs/persona).
