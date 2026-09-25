---
title: Sync
description: How encrypted journal files move between your own devices.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/sync/engine.rs, src-tauri/src/sync/entry_sync.rs, src-tauri/src/sync/metadata.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/embedding_sync.rs, src-tauri/src/sync/keyring_v2/types.rs, src-tauri/src/sync/gdrive_provider.rs, src-tauri/src/sync/gdrive_oauth.rs, src-tauri/src/sync/local_provider.rs, src-tauri/src/sync/cloud_provider.rs, src-tauri/src/sync/recovery.rs, src-tauri/src/utils/recovery.rs, src-tauri/src/commands/gdrive.rs, src-tauri/src/commands/sync.rs, docs/plans/2026-09-05-icloud-sync-provider/README.md
---

# Sync

Sync is off until you turn it on; with no Memlore server or account in between, your devices copy the journal through one place you control.

:::widget sync-steps

## Where the copy lives

:::cards

- **Google Drive** — A hidden app folder that does not show in your Drive. Memlore cannot open the rest.
- **iCloud Drive, on a Mac** — A Memlore folder in iCloud Drive. No Apple password stored.
- **A folder of your own** — Another drive or shared directory gets the same sealed files.

:::

## What the cloud can read

- Entries, attachments, journal names, settings, and chats are sealed first. See [Encryption](/docs/encryption).
- The sync list stays readable: ids, change times, and deletions.
- The device list stays readable: each device's name, id, and when it was added and last seen.
- Neither list includes the words you wrote.
- The 24 recovery words are never uploaded, only a key they seal.

## Edits on two devices

- Your device opens the other device's files itself; Google and Apple do not combine the writing.
- Writing inside an entry edited on both devices is kept from both sides.
- A title, journal name, or setting keeps the later save.

## Turning sync off

- Disconnecting stops sync here; this device's journal and the cloud files both stay.
- Delete the cloud copy and disconnect, and this device won't upload again until you reconnect.
- A device still connected can put its copy back on its next sync.

## Removing the cloud copy

- Google: open Google Drive settings, then Manage apps, then Memlore, then Disconnect from Drive.
- iCloud: delete the Memlore folder in iCloud Drive yourself.
