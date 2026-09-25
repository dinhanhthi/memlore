---
title: Sync
description: How encrypted journal files move between your own devices.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/sync/engine.rs, src-tauri/src/sync/entry_sync.rs, src-tauri/src/sync/metadata.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/embedding_sync.rs, src-tauri/src/sync/keyring_v2/types.rs, src-tauri/src/sync/gdrive_provider.rs, src-tauri/src/sync/gdrive_oauth.rs, src-tauri/src/sync/local_provider.rs, src-tauri/src/sync/cloud_provider.rs, src-tauri/src/sync/recovery.rs, src-tauri/src/utils/recovery.rs, src-tauri/src/commands/gdrive.rs, src-tauri/src/commands/sync.rs, docs/plans/2026-09-05-icloud-sync-provider/README.md
---

# Sync

Sync is optional. It stays off until you turn it on. There is no Memlore server, and no Memlore account, between your devices. You pick one place you already control, and your devices copy the journal through that place.

## Where the copy lives

You connect one place at a time.

Google Drive uses your own Google account. Memlore asks only for a hidden folder that belongs to the app. Those files do not appear on drive.google.com, and Memlore cannot open the rest of your Drive. The sign-in that reaches that folder, your Google email, and your Drive space stay in the encrypted database on this device. They are removed from this device when you disconnect. The short-lived pass for each session stays in memory and is gone when you quit the app.

On a Mac you can choose iCloud Drive instead. Memlore writes a Memlore folder in the iCloud Drive you already see in Finder. It does not sign in to Apple for you, and it does not store an Apple password. It uses the iCloud Drive session already on this Mac. Apple does not receive your journal as readable text.

You can also choose a folder of your own, such as another drive or a shared directory. The same sealed files are written there.

## What gets uploaded

Before a file leaves this device, Memlore seals it. Entries, photos and other attachments, journal names, settings, and chats all go out sealed. How that sealing works is on [Encryption](/docs/encryption).

Each device seals its entries, then uploads them. The cloud holds a folder of sealed envelopes. It can store them and hand them to your other device. It cannot open them.

:::diagram sync

A few files stay readable so your other devices know what to fetch. The sync list for each device includes ids for entries and journals, the time each one changed, and whether it was deleted. It does not include the words you wrote. A device list includes each device's name, its id, and when it was added and last seen. The cloud can read that name. It still cannot read the journal.

## When two devices both wrote

Each device keeps what it wrote and downloads the sealed files the other device uploaded. Google and Apple do not combine the writing. Your device opens the envelopes itself.

If you edit the same entry on two devices before they sync, the writing inside the entry is kept from both sides. Every device keeps a log of small changes that combine in any order. A title, a journal name, or a setting keeps the later save instead.

If you delete an entry, that deletion is recorded in the list. The other device removes the entry when that deletion is the newer change.

## The 24-word phrase

When you first set Memlore up, it creates a 24-word phrase. It turns those words into a key. That key seals the key that opens your journal, and the sealed copy can be stored with your cloud files. The 24 words themselves are not uploaded. What to do with the phrase is on [Backup and recovery](/docs/backup-and-recovery).

## What this means for you

- Your journal works with sync off. Turning sync on does not send it to Memlore.
- The place you picked can hold the files. It can read the sync list and your device name. It cannot read the entries, the photos, or the key that opens them.
- You can turn background sync off without disconnecting. The files stay where they are.
- Disconnecting this device stops sync here. The journal on this device stays. The files already in the cloud stay too.
- If you delete the cloud copy and disconnect, the journal on this device stays. This device does not upload again until you connect sync again. A device that is still connected can put its copy back on its next sync.
- If the cloud copy is cleared and this device stays connected, Memlore marks your entries, journals, and attachments to upload again in that same step. The next sync sends them, instead of treating the removed copy as already uploaded.
- On Google Drive, disconnecting in the app does not remove the hidden folder. You can remove that Google-side copy from Google Drive settings, under Manage apps, then Memlore, then Disconnect from Drive.
- On iCloud Drive, disconnecting does not delete the Memlore folder. Remove that folder yourself if you want that copy gone.
