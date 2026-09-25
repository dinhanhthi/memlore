---
title: Search and media
description: How word search, meaning search, and attached photos and video stay on your device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/db/schema.rs, src-tauri/src/db/queries.rs, src-tauri/src/db/embeddings.rs, src-tauri/src/commands/search.rs, src-tauri/src/commands/media.rs, src-tauri/src/commands/export.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/embedding_sync.rs, src-tauri/src/ai/providers/on_device_embed.rs, src-tauri/src/utils/image_compression.rs, src-tauri/src/utils/video_compression.rs, src-tauri/src/utils/thumbnail.rs
---

# Search and media

You can search by the words you type or by meaning, and attachments stay on this device unless you turn sync on.

:::diagram search

## Word search

- It looks at titles and text inside the encrypted database.
- The words you type are not sent anywhere.
- It cannot see inside attached files or find a photo by what it shows.

## Meaning search

- It stays off until you choose a helper.
- An on-device model, downloaded once, stays on this computer.
- A provider you pick receives passage text and your question; Memlore cannot stop it reading them.
- A helper on another computer on your network still gets the text, without a privacy notice. See [AI](/docs/ai).

## Locks and hidden journals

- Both searches leave closed locks and hidden journals out of results until you open them.
- Hidden entries are never sent to a meaning helper.
- With **Include locked entries** on, locked text is sent before you open the second lock. See [Locks](/docs/locks).

## Photos, video, and files

- They are **not encrypted** on this computer; anyone who opens the media folder can open them.
- Sync is off until you turn it on; files are sealed on this device first. See [Sync](/docs/sync).
- A Memlore export is **not encrypted**; attachments are ordinary files in it. See [Backup and recovery](/docs/backup-and-recovery).
- Only a Mac can make a video smaller; elsewhere clips stay as added.
