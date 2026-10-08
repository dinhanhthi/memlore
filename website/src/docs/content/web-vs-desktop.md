---
title: Web vs desktop
description: What Memlore Web can do today, what stays on the desktop app, and why.
updated: 2026-10-08
sources: web/src/backend/unsupported.ts, src/lib/platform.ts, web/static/_headers, website/src/docs/content/web.md
---

# Web vs desktop

Memlore Web is an optional companion to the desktop app. It opens a vault you already created on the desktop and synced to Google Drive. Editing on the web is built but still rolling out; until it is turned on, the web opens your journal read-only.

## Feature by feature

| Feature                                                                                                       | Desktop | Web                | Notes                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform                                                                                                      | macOS   | Any modern browser | Windows and Linux desktop builds are planned.                                                                                              |
| **Reading and writing**                                                                                       |         |                    |                                                                                                                                            |
| Read and search entries                                                                                       | ✅      | ✅                 | Web search runs in your browser and fetches entries as needed. Results are sorted by date instead of the desktop's ranked full-text index. |
| Write and edit entries, assign existing tags and journals, use templates, add photos and video                | ✅      | Rolling out        | Web video uploads are capped at 100 MB.                                                                                                    |
| Create or rename tags and journals, edit templates                                                            | ✅      | Desktop only       |                                                                                                                                            |
| Delete entries                                                                                                | ✅      | Desktop only       |                                                                                                                                            |
| Audio memos and file attachments                                                                              | ✅      | Desktop only       |                                                                                                                                            |
| **AI**                                                                                                        |         |                    |                                                                                                                                            |
| Daily chat, AI writing tools, memory and persona, semantic search                                             | ✅      | Desktop only       |                                                                                                                                            |
| **Looking back**                                                                                              |         |                    |                                                                                                                                            |
| Stats, calendar, streak, media library, On this day, map                                                      | ✅      | Desktop only       |                                                                                                                                            |
| Version history                                                                                               | ✅      | Desktop only       |                                                                                                                                            |
| **Vault and device**                                                                                          |         |                    |                                                                                                                                            |
| Import and export, reminders, iCloud Drive sync, key rotation and device management, create a vault, Touch ID | ✅      | Desktop only       |                                                                                                                                            |
| Locked entries and the invisible vault                                                                        | ✅      | Never shown        | Their content is discarded right after opening.                                                                                            |
| Auto-lock, lock, themes, languages                                                                            | ✅      | ✅                 |                                                                                                                                            |

## Why some features stay on desktop

- **Zero-knowledge.** The web never sends your writing, passwords, or keys to a Memlore server, so features that would need one are left out.
- **No server.** Your journal travels only between your browser and Google Drive. A small Memlore sign-in service handles the Google token exchange and never sees your writing or keys, so there is nowhere to run AI, build an index, or send reminders.
- **Lazy reads.** The web fetches and decrypts entries on demand instead of holding the whole journal, so features that scan every entry stay on the desktop.
- **Deletion safety.** Deleting cannot be undone, so it is kept on the desktop, away from shared or borrowed computers.
- **Operating system only.** iCloud Drive, Touch ID, and reminders depend on the operating system and have no browser equivalent.
