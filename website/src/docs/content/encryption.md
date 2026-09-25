---
title: Encryption
description: How your password seals a random key that locks the journal database on this computer.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/utils/encryption.rs, src-tauri/src/utils/boot_file.rs, src-tauri/src/utils/recovery.rs, src-tauri/src/commands/crypto.rs, src-tauri/src/db/mod.rs, src-tauri/src/db/schema.rs, src-tauri/src/db/queries.rs, src-tauri/src/lib.rs, src-tauri/src/commands/media.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/local_keyring_v2.rs, src-tauri/src/sync/keyring_v2/types.rs, src-tauri/src/sync/rotation/publish.rs, src-tauri/src/utils/second_lock.rs, src-tauri/src/utils/invisible_lock.rs
---

# Encryption

The journal on this computer is locked. Your password is not the key inside the database. The app uses it, slowly, to open a locked box. Inside that box is a random master key, and the master key is what reaches the journal.

## What is encrypted on disk

**The journal database is encrypted.** Entries live in one database file. SQLCipher encrypts each page of that file. The database code describes each page as AES-CBC, with an HMAC-SHA512 check on the page. The app does not set a page size or a compatibility mode. It passes a raw key in before any other database command. Without that key, the file does not open as a database.

**The setup file beside it is not encrypted.** That small file is plain text. It holds the sealed master key, the salt for the slow step, and related lock data. It does not hold entry text. Reading it shows sealed blobs, not the journal.

**Photos and other attachments on this computer are not encrypted.** The app writes them as ordinary files in the media folder, so they can be opened without your password. A copy sent for sync is different. Entries and media are encrypted on this device before upload, with AES-256-GCM. A short sync list — ids, times, deletion flags, and the device name — is not journal text. It stays readable so your other devices know what to fetch.

## Your password and the master key

Picture a locked box that holds one key, and a cabinet that key can open. Your password is not the key in the box. The app turns the password into a wrapping key, and it does that slowly so guessing is expensive.

The slow step is Argon2id. Each try spends memory and time on purpose. What comes out is the wrapping key. The password is not saved in the journal in place of that key.

The wrapping key seals a master key made of random bytes the first time you set a password. The seal is AES-256-GCM, so the box opens only when that wrapping key matches. The database is not locked with the password itself. The master key reaches a separate per-device key, and SQLCipher opens the file with a key derived from that, not with your password and not with the master key's own bytes.

:::diagram encryption

The 24 recovery words open the same box by another lock. They become a key without Argon2id, because the words are already a long random secret, and that key seals the master key with AES-256-GCM. How to keep the words is in [Backup and recovery](/docs/backup-and-recovery).

On a Mac, you can also let the system keychain hold a key that opens the same box. That keychain key is not stored in the journal folder.

## A wrong password

A wrong password still goes through the slow step. The wrapping key it produces does not open the seal. The app reports an invalid password and does not open the database. The check is yes or no. It does not say how close the guess was, and the journal file stays locked.

## Someone with the laptop

If someone copies the files while the app is locked, this is what those files show.

- The database file is there, and it does not open as a database without the key.
- The setup file is readable. It shows that a password lock is in use, and it contains sealed keys. It does not contain your entries.
- Photos, video, audio, and other attachments are readable, because those files are not encrypted.
- The password is not in the folder. The 24 words are not in the setup file either. What is there is a sealed master key those words can open.
- A Mac keychain key, if you turned that on, is not in the journal folder. The sealed blob does nothing without the keychain.

While the app is unlocked, it keeps the keys in memory so it can read the journal. Those raw keys are not written into the database.

## What this means for you

- The slow step makes every guess costly. A password someone else can guess is still easier to try than one they do not know.
- The password wraps the master key. It is not the master key. Forgetting the password does not throw the journal away if you still have the recovery words, or a keychain unlock you already turned on.
- If the password, the recovery words, and any keychain unlock are all gone, the app cannot rebuild the master key. There is no Memlore account that can reset it. Keep the words as described in [Backup and recovery](/docs/backup-and-recovery).
- [Locks](/docs/locks) are a different control. An invisible vault and a second lock each check a password before the app shows those entries. They do not move an entry into its own encrypted file. The entry stays in this same database.
- Treat the computer as part of keeping photos and other attachments private. The journal text is encrypted on disk. Those files are not.
