---
title: How privacy works
description: What stays on your device, and what leaves only when you turn a feature on.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/tauri.conf.json, src-tauri/src/commands/updater.rs, src/hooks/useUpdater.ts, src-tauri/src/sync/gdrive_oauth.rs, src-tauri/src/sync/gdrive_provider.rs, src-tauri/src/commands/ai_provider.rs, src-tauri/src/ai/on_device/llm_catalog.rs, src-tauri/src/ai/on_device/server_binary.rs, src-tauri/src/utils/geocoding.rs, src/types/geocoding.ts, src-tauri/src/utils/weather.rs, src-tauri/src/commands/basemap.rs, src/components/map/LeafletMap.tsx, src/lib/mapkitLoader.ts, src-tauri/src/commands/fonts.rs, website/tokens.css
---

# How privacy works

Your journal lives on your device, and Memlore has no server that stores it.

:::widget privacy-toggle

## What stays on this device

- Entries sit in an encrypted database that Memlore cannot open.
- There is no Memlore account.
- Writing, search, locks, and the editor work offline.
- The app has no telemetry, analytics, advertising, or tracking.

## What leaves only when you turn it on

- **Sync:** encrypted copies plus a readable sync list go to your Google Drive, or iCloud Drive on a Mac.
- The sync list holds IDs, times, deletion flags, and your device name, not journal text.
- Drive access is limited to a hidden app folder; iCloud needs no Apple password.
- **Maps and weather:** a place search, map pictures, or a location and date. Never your entry text.
- **Fonts:** a font file, if you download a Google font.

## AI

- Text you choose to send goes to the hosted provider you pick.
- A helper on another computer on your network gets your journal text, with no privacy notice.
- An on-device model runs on this computer, and its download does not include your journal.
- Memlore does not run a hosted service and cannot see that traffic.

## Update check

- Opening the app sends a version check to GitHub, not your journal.
- It is the only path on by default, and you can turn it off.
