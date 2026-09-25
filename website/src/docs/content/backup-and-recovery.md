---
title: Backup and recovery
description: How to keep a copy of your journal, and what you need if you forget the password.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/utils/recovery.rs, src-tauri/src/sync/recovery.rs, src-tauri/src/commands/crypto.rs, src-tauri/src/commands/export.rs, src-tauri/src/commands/import.rs, src-tauri/src/commands/recovery_sheet.rs, src/hooks/useRecoverySheet.ts, src/components/auth/RecoveryPassphraseRevealScreen.tsx, src/components/auth/ForgotPasswordScreen.tsx, src/components/auth/OnboardNewDeviceScreen.tsx, src/components/settings/RotationRecoveryRevealModal.tsx, src/components/settings/data/ExportModal.tsx, src/components/settings/data/ImportModal.tsx
---

# Backup and recovery

There is no account, so no one can reset your password for you.

:::diagram backup

## The recovery sheet

- Your first password creates 24 recovery words, not a backup of entries.
- Anyone with the PDF can read it; keep it offline, not in synced folders.
- After you confirm you saved it, nothing can show the words again.
- Until you confirm, a full export holds the words as readable text.

## If you forget the password

- Reset on this computer takes the 24 words and a new password.
- Reset needs the sealed key on this computer; a journal set up before reset existed cannot reset here.
- On a Mac, Touch ID you already turned on there still opens the journal.
- Lose every password, Touch ID, and the words, and the journal cannot be opened, even with a cloud copy.

## Copies you save

- Exports are **not encrypted**; anyone with the file can read it.
- A Memlore zip holds text, tags, and photos; a full export adds a readable database.
- A plain-text zip has one file per entry, no photos.
- Hidden entries skip plain text but are inside a full Memlore file as readable text, with their photos.
- Entries with an extra password are in every export, even plain text.

## Cloud copies and a new computer

- Before you pick between cloud and computer, Memlore writes a safety file; its file list and photos are not encrypted.
- A new computer joins with the words or QR code, or imports a Memlore file.
