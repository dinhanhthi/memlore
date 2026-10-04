---
title: Web companion
description: How Memlore Web works, how to sign in with your recovery phrase, and what is supported.
updated: 2026-10-04
sources: website/src/legal/privacy.md, docs/web/desktop-vs-web.md, docs/web/architecture.md, docs/web/sync-and-encryption.md
---

# Web Companion

Memlore Web ([web.memlore.app](https://web.memlore.app)) is an optional in-browser companion to the Memlore desktop app. It allows you to open, search, and edit your existing journal from any modern web browser without sending your journal content, passwords, or encryption keys to any application server.

---

## How to sign in

Memlore Web opens an **existing vault** that has already been created on your desktop and synced to Google Drive.

1. Open [web.memlore.app](https://web.memlore.app) in any modern browser (Chrome, Safari, Firefox, Edge).
2. Click **Sign in with Google** and authorize access to your Google Drive application data folder.
3. Enter your **24-word recovery phrase** from your desktop app (found in Desktop Settings → Security & Backup → Recovery Phrase).
4. Set a **local web password**. This password encrypts your session credentials in your browser's local storage so you do not need to re-enter the 24 words on every visit.

:::cards

- **Zero-knowledge keys** — Your 24-word recovery phrase and master keys are unpacked in WebAssembly memory and are never sent across the network.
- **Direct cloud connection** — Your browser communicates directly with Google Drive APIs over HTTPS. There is no Memlore intermediate server.

:::

---

## What works and what is desktop-only

Memlore Web is designed for reading, fast lookup, and writing entries while away from your primary computer.

:::cards

- **Read entries & view media** — Streamed and decrypted on demand from your Google Drive `appDataFolder`.
- **Write & edit entries** — Saved immediately to your private web outbox, then imported and merged by desktop.
- **Assign tags & journals** — Assign any existing tags and journals to your entries directly in the web editor.
- **Delete entries (Desktop only)** — Irreversible deletion cascades are reserved for the native desktop app.
- **Create tags or journals (Desktop only)** — Taxonomy definitions are managed on your primary desktop.
- **AI assistant & chat (Desktop only)** — The zero-telemetry web companion omits external AI connections.
- **Full statistics & heatmap (Desktop only)** — Preserves the web's lightweight, on-demand pull model.
- **iCloud Drive sync (Desktop only)** — Web connects to Google Drive; Apple provides no web API for iCloud Drive folders.

:::

For security invariants and technical design, see the [Privacy Policy](/privacy) and [Sync documentation](/docs/sync).

---

## Safety and the outbox model

Your desktop vault is always the primary authority. To guarantee that a browser session can never corrupt your journal database:

- **Web never writes sync protocol files directly.** Instead, the web companion creates sealed write intents in a private `outbox/` folder.
- **Desktop imports and verifies all edits.** When your desktop app syncs, it reads the outbox, merges text changes using CRDTs (so concurrent typing is preserved), and saves the result to your local encrypted database.
- **No entry deletion.** To protect against accidental deletions or compromised shared computers, entries cannot be deleted on the web. Deletions must be made on desktop.
- **Instant revocation.** You can cut off web access at any time from your desktop app: open Settings → Devices → click **Remove Device** on the web companion. The web tab will instantly wipe its local cache and lock.

---

## Caching and privacy on shared computers

- **Encrypted local storage:** Memlore Web caches downloaded entry files in your browser's IndexedDB strictly as **AES-256-GCM ciphertexts**. Unencrypted text is never stored on disk.
- **In-memory keys:** Encryption keys live strictly in volatile WebAssembly memory. When you click **Lock** or close the browser tab, all decryption keys are erased from RAM immediately.
- **Clearing the cache:** If you use Memlore Web on a public or shared device, open Settings and click **Clear web cache**, or sign out before leaving.
