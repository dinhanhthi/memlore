---
title: Encryption
description: How your password seals a random key that locks the journal database on this computer.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/utils/encryption.rs, src-tauri/src/utils/boot_file.rs, src-tauri/src/utils/recovery.rs, src-tauri/src/commands/crypto.rs, src-tauri/src/db/mod.rs, src-tauri/src/db/schema.rs, src-tauri/src/db/queries.rs, src-tauri/src/lib.rs, src-tauri/src/commands/media.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/local_keyring_v2.rs, src-tauri/src/sync/keyring_v2/types.rs, src-tauri/src/sync/rotation/publish.rs, src-tauri/src/utils/second_lock.rs, src-tauri/src/utils/invisible_lock.rs
---

# Encryption

A random master key locks the journal on this computer; your password opens the box holding it.

:::widget encryption-steps

## Your password and the master key

- Argon2id turns your password into a wrapping key; this slow step makes guessing expensive.
- That wrapping key seals a random master key with AES-256-GCM.
- The 24 recovery words open the same box by another lock, without Argon2id.
- On a Mac, the keychain can hold another key, outside the journal folder.
- A wrong password does not open the seal, and the journal stays locked.

## What is encrypted on disk

:::cards

- **Journal database** — Encrypted by SQLCipher. Without the key, it does not open.
- **Setup file** — Not encrypted. Holds the sealed master key and salt, no entry text.
- **Photos and attachments** — Not encrypted. They open without your password.

:::

## If you lose access

- Forgot the password? The journal is not thrown away if you still have the recovery words or a keychain unlock you turned on. See [Backup and recovery](/docs/backup-and-recovery).
- Lose the password, the words, and any keychain unlock, and the master key cannot be rebuilt.
- No Memlore account can reset it.

## Good to know

- While unlocked, the app keeps the keys in memory; those raw keys are not written into the database.
- A password someone else can guess is still easier to try.
- Sync copies of entries and media are encrypted on this device before upload.
- [Locks](/docs/locks) check a password before showing entries; they add no encryption.
