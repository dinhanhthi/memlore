---
title: Backup and recovery
description: How to keep a copy of your journal, and what you need if you forget the password.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/utils/recovery.rs, src-tauri/src/sync/recovery.rs, src-tauri/src/commands/crypto.rs, src-tauri/src/commands/export.rs, src-tauri/src/commands/import.rs, src-tauri/src/commands/recovery_sheet.rs, src/hooks/useRecoverySheet.ts, src/components/auth/RecoveryPassphraseRevealScreen.tsx, src/components/auth/ForgotPasswordScreen.tsx, src/components/auth/OnboardNewDeviceScreen.tsx, src/components/settings/RotationRecoveryRevealModal.tsx, src/components/settings/data/ExportModal.tsx, src/components/settings/data/ImportModal.tsx
---

# Backup and recovery

Your journal lives in an encrypted database on your computer. Two different things can help later. The recovery sheet lets you set a new password. An export is a file you choose to save. Memlore cannot replace either one for you. How the database stays locked is on [Encryption](/docs/encryption).

## The recovery sheet

When you first set a password, Memlore creates **24 English words**. That list is the recovery sheet. You can read the words, copy them, or save a PDF. The PDF prints the words in plain text and adds a QR code of the same words. You pick the folder. Memlore does not choose one for you.

The app shows the words during setup. They are deleted only after you confirm you saved them. Before that, quitting or a crash keeps them, and the app shows them again. Cancelling setup deletes them too. After you confirm, this computer keeps only the sealed key, not the 24 words. The cloud copy cannot hand the words back. If you confirmed and did not save them, they are gone. Until you confirm, a full export writes those words into the readable snapshot.

The sheet is not a backup of your entries. It is a copy of the one secret you already have. Anyone who opens the PDF can read the words. Keep it offline. Do not leave it in a synced folder or a photo library.

If the words leak, you can replace them while you still know your password. Memlore makes a new set of 24 words. The old sheet stops working. The new 24 words are shown only in that session. Quitting or a crash after the replacement finishes does not show them again, because the database copy is deleted when the command succeeds.

## If you forget the password

On this computer, reset asks for the 24 words and a new password. That works with no internet, and it does not need Google Drive. The journal stays the same. Only the password changes, so the same words still work afterward. Extra spaces and capital letters are fine. A wrong phrase does not open the journal.

This works only if this computer still holds the sealed master key those words can open. That sealed key is not the 24 words. After you confirm you saved the sheet, the words are not kept here, so you still need the sheet. If the sealed key is missing, the app says recovery is unavailable. A journal set up before this reset existed cannot be reset here.

Each computer has its own password. On a Mac, Touch ID you already turned on can still open the journal on that computer. You do not need the words for that. A computer that is already set up can keep opening its copy, as long as you can still unlock it.

## Copies you save

An export is a file on your disk. It is **not encrypted**. Anyone who can open the file can read the writing.

- A Memlore zip holds readable journal text, your journals and tags, and copies of photos and other files. A full export also includes a readable snapshot of the database.
- A plain-text export is a zip of text files, one per entry. Each file is the title and the body. It has no photos.
- The app can also pack Markdown into a zip of ordinary text files. In Settings, choosing Markdown still saves a Memlore zip today.

Hidden journals and hidden entries are left out of that entry list, and out of a plain-text export. They are still inside a full Memlore file, in the database snapshot, as readable text. Photos and other files from those hidden entries are copied into the zip too, as ordinary files in the media folder. They are not locked again. An entry with an extra password is not left out. Its text is in the file too.

If sync is on and this computer has not finished pulling, the export will not start.

You can bring a file back in. A Memlore file can sit beside what you already have. When the same entry exists in both places, the newer one wins. Or you can replace your entries, tags, and media. Your journals stay, and they are updated from the file. You can also import a folder of Markdown, a folder of plain text, a Day One JSON export, a Journey export, or an Apple Journal folder.

## When the cloud copy and this computer disagree

This is not password recovery. If sync looks wrong, you choose which copy to keep: this computer, or the cloud. Before Memlore replaces either side, it writes a safety file on this computer. That file is also a Memlore zip.

In that safety file, the database snapshot is encrypted. The short file list is not. Photos and other files are copied as they already are on disk. They are not locked again. If the safety file cannot be written, Memlore stops and does not change the cloud. How those copies move is on [Sync](/docs/sync).

## A new computer

The sheet does not carry your entries. To join a journal that is already in the cloud, type the 24 words, or choose a picture of the sheet's QR code. Memlore does not use the camera. There is no direct handoff from one computer to another. You then set a password on the new computer.

Without sync, copy a Memlore file across and import it. Treat that file like the journal. It is readable.

## What this means for you

Store the sheet offline, on paper or on a drive you control. Memlore cannot recover a lost password without it. There is no account, and no one who can reset it for you.

If you lose every password, no Mac can still unlock with Touch ID, and you lose the 24 words, the journal cannot be opened. A cloud copy does not change that. It is locked with the same secret.
