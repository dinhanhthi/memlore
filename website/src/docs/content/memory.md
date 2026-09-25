---
title: Memory
description: How Memlore keeps short facts about you, and which model reads your writing to make them.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/commands/ai_memory.rs, src-tauri/src/ai/memory_extractor.rs, src-tauri/src/ai/provider_registry.rs, src-tauri/src/db/memory.rs, src-tauri/src/db/schema.rs, src-tauri/src/sync/engine.rs, src/components/settings/MemoriesSettings.tsx, src/components/settings/AISettingsPanel.tsx, src/locales/en/ai.json
---

# Memory

Memory is an optional list of short facts about you, and it stays off until you turn it on.

:::diagram memory

## What it keeps

- Each fact is one lasting sentence, such as your work or people.
- Passing moods are meant to be left out.
- Facts live in the encrypted database; there is no Memlore server copy.
- Sync is off by default; synced facts are encrypted before upload.

## What a scan sends

- Turn on **Enable User Memory** and pick one model that writes facts and one that matches them.
- While Memory is on, scans run on their own over recent entries and chats.
- A scan sends the writing itself, not only the saved fact.
- An on-device model keeps it here; a helper on your network or a hosted provider receives it. See [AI](/docs/ai).

## Locked and invisible entries

- Invisible entries are always left out.
- Locked entries are left out unless you turn on **Include locked entries**, which starts off.
- With it on, locked text can reach an off-device model and become a fact.

## Memory in Daily Chat

- **Use Memory in Chat** starts off.
- When on, matching facts reach the chat provider, and your message goes to the matching model.

## View, change, or delete

- **Manage memories** lets you rewrite, turn off, or delete a fact.
- Turning Memory off stops scans and chat use but keeps facts; turn it back on to review or delete them.
