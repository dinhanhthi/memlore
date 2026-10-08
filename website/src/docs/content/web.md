---
title: Web companion
description: How Memlore Web works, how to sign in with your recovery phrase, and what is supported.
updated: 2026-10-08
sources: website/src/legal/privacy.md
---

# Web Companion

Memlore Web ([web.memlore.app](https://web.memlore.app)) is an optional in-browser companion to the Memlore desktop app. It allows you to open and search your existing journal, and to edit it once editing on the web is turned on, from any modern web browser without sending your journal content, passwords, or encryption keys to any application server.

---

## How to sign in

Memlore Web opens an **existing vault** that has already been created on your desktop and synced to Google Drive.

1. Open [web.memlore.app](https://web.memlore.app) in any modern browser (Chrome, Safari, Firefox, Edge).
2. Click **Sign in with Google** and authorize access to your Google Drive application data folder.
3. Enter the **24-word recovery phrase** you saved when you set up Memlore on your desktop.
4. Set a **local web password**. This password encrypts your session credentials in your browser's local storage so you do not need to re-enter the 24 words on every visit.

:::cards

- **Zero-knowledge keys** — Your 24-word recovery phrase and master keys are unpacked in WebAssembly memory and are never sent across the network.
- **Direct cloud connection** — Your browser communicates directly with Google Drive APIs over HTTPS. There is no Memlore intermediate server.

:::

---

## What works and what is desktop-only

You can read and search your journal on the web today. Writing and editing are rolling out, and most other features stay on the desktop app. See [Web vs desktop](/docs/web-vs-desktop) for the full feature-by-feature table.

For security invariants and technical design, see the [Privacy Policy](/privacy) and [Sync documentation](/docs/sync).

---

## Safety and the outbox model

Your desktop vault is always the primary authority. To guarantee that a browser session can never corrupt your journal database:

- **Web never writes sync protocol files directly.** Instead, the web companion creates sealed write intents in a private `outbox/` folder.
- **Desktop imports and verifies all edits.** When your desktop app syncs, it reads the outbox, merges text changes using CRDTs (so concurrent typing is preserved), and saves the result to your local encrypted database.
- **No entry deletion.** To protect against accidental deletions or compromised shared computers, entries cannot be deleted on the web. Deletions must be made on desktop.
- **Instant revocation.** You can cut off web access at any time from your desktop app: open Settings → Security → Security actions → Connected devices and remove the web companion. At its next sync the web tab drops its cached entries and locks; its unsent edits stay sealed in the browser until you re-connect or clear the site data.

---

## Caching and privacy on shared computers

- **Encrypted local storage:** Memlore Web caches downloaded entry files in your browser's IndexedDB strictly as **AES-256-GCM ciphertexts**. Unencrypted text is never stored on disk.
- **In-memory keys:** Encryption keys live strictly in volatile WebAssembly memory. When you click **Lock** or close the browser tab, all decryption keys are erased from RAM immediately.
- **Leaving a shared device:** **Clear cache** in Memlore Web settings removes cached photos and videos only. To remove everything Memlore Web stored in that browser (cached entries, unsent edits and the password-wrapped key), clear the site data for web.memlore.app in the browser's settings before leaving.
