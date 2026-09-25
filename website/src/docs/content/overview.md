---
title: Overview
description: Your journal stays on this device, and you choose what, if anything, leaves it.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/src/legal/about.md, website/src/LandingPage.tsx, website/src/docs/manifest.ts, website/src/docs/DocsPage.tsx, Agents.md, src/components/layout/EditorPanel.tsx, src/hooks/useEntries.ts, src/hooks/applyEntryWeather.ts, src-tauri/src/utils/weather.rs, src-tauri/src/commands/fonts.rs, src/lib/tauri.ts
---

# Overview

Memlore is a private journal on your device. It is locked with your password. Your writing stays in an encrypted database on that device.

Think of a paper diary in a locked drawer at home. You can later copy it into a cloud folder you already own. You can also send a page to an AI provider you choose. Until you do, the diary stays in the drawer.

There is no Memlore account and no Memlore server. We cannot read your journal. You can write with the network off. Sync, AI, and maps stay off until you turn them on.

## Where to start

Start with the three protection pages if you want the limits in writing.

1. [How privacy works](/docs/how-privacy-works) says what stays on the device, and what leaves only after you opt in.
2. [Encryption](/docs/encryption) says how the journal is locked, and what the recovery sheet is for.
3. [Locks](/docs/locks) says how the app lock, an invisible vault, and a second lock hide entries.

You do not need those pages before you write. The app opens with your password. On a Mac, you can also turn on Touch ID. Touch ID does not replace the password. If you cancel the prompt, you type the password.

If you only want the short version, keep reading here. The later pages take one topic at a time.

## What stays on this device

Your journal lives on your computer. It does not live on a server we run. The database is encrypted. We cannot read it.

You can write, reopen a page, and search while the network is off. Photos, video, and other files you attach stay in that same vault. The search and media page explains that local search. A meaning-based search is different. It is an AI feature, so it stays off until you opt in.

The app may ask GitHub whether an update is available. That check is not a copy of your journal. It is not tracking.

The download on this site is for Mac today. Other platforms are not available yet.

## What you turn on yourself

Sync stays off until you turn it on. You pick one place you already have. That is your Google Drive, or iCloud Drive on a Mac. There is no Memlore server in between.

Entries, media, and settings are encrypted on your device before they upload. A short sync list is not your writing. It holds IDs, times, deletion flags, and your device name, so another device of yours knows what to fetch. Disconnecting in the app does not delete files already in that cloud folder. You remove those yourself if you want the copy gone.

AI stays off until you choose a provider. A local or on-device path does not ask for a privacy notice. A hosted provider does, and so does the Claude or Codex program on this computer. You choose a local or on-device path, or a hosted provider. If you pick a hosted provider, the text you send goes to that provider. Memlore does not run that service. Memlore does not see that traffic.

The map stays empty until you pick a source. Place search runs when you type. Photon is the default until you pick another service. Neither one receives the words of the entry. A place on an entry is a separate step. If you save a place, or a default place is turned on, Memlore also asks Open-Meteo for the weather at that place and date. You do not choose that weather service. There is no speech-to-text. Speaking in the app stores a voice memo on this computer. It does not send audio to a provider.

You can change how the app looks. There are three designs: Signature, Clean, and Clay. You can use light or dark. The editor font can be a face that ships with the app. If you pick a Google Font instead, Memlore downloads that font from Google.

## The rest of the app

Each entry is one document. You write it, then you reopen it later. The editor covers words, Markdown, math, code, media, and mentions. Plugins are not available yet.

You can mark a mood on an entry and look back at it over time. You can put an entry on a map. You can import entries, including media, and export them again.

A conversation about the day can become an entry when you save it. That stays off until you opt in. You can also speak instead of type. That stores a voice memo on this computer. It does not need a provider, and the audio is not sent out. A writing persona, and short facts drawn from your journal and from what you type in Daily Chat, are AI features. They stay off until you opt in too.

None of that changes the rule above. The journal is still on your device. A feature sends something only after you turn that feature on, or after you save a place and the weather lookup runs.

## What this means for you

- You can keep a journal with no Memlore account, and you can write while offline.
- You open the app with your password. Touch ID is an extra unlock on a Mac, not a second password.
- **Memlore cannot** read your journal.
- **Memlore cannot** keep a copy on a server of its own. There is no Memlore server.
- **Memlore cannot** get you back in by itself if you lose the password. Read backup and recovery for what you need. The encryption page explains the recovery sheet.
- **Memlore cannot** turn on sync, AI, or maps for you.
- **Memlore cannot** see the rest of your Google Drive. Drive sync uses a hidden app folder in your own account.
- **Memlore cannot** delete the Drive or iCloud copy when you disconnect. You remove that folder yourself.
- **Memlore cannot** keep a hosted AI request on your device. The text you send goes to the provider you chose.
- **Memlore cannot** offer plugins yet.
- **Memlore cannot** run from this site on a phone, Windows, or Linux today. The download is for Mac.
- Saving a place also sends that place and the entry date to Open-Meteo. That is not the map provider you pick.
- Choosing a Google Font downloads the font from Google. Built-in fonts do not.
- The app does not include telemetry, analytics, advertising, or tracking.

## What comes next

The sidebar has two groups after this page. The links below follow that same split.

**How your journal is protected** is the first group. These pages spell out the limits.

- [How privacy works](/docs/how-privacy-works) — what stays on your device, and what leaves only when you turn a feature on.
- [Encryption](/docs/encryption) — how your journal is encrypted, and what the recovery sheet is for.
- [Locks](/docs/locks) — how the app lock, an invisible vault, and a second lock hide entries.

**Features** is the second group. These pages cover the rest of the app.

- [Sync](/docs/sync) — how encrypted journal files move between your own devices.
- [AI](/docs/ai) — how optional AI features use your journal, and what they do not send.
- [Backup and recovery](/docs/backup-and-recovery) — how to keep a copy, and what you need if you lose the password.
- [Search and media](/docs/search-and-media) — how search and attached photos, video, and files stay in the vault.
- [Memory](/docs/memory) — how Memlore keeps short facts drawn from your journal and from Daily Chat.
- [Persona](/docs/persona) — how a writing persona changes replies when you write with AI.
- [Customization](/docs/customization) — how themes, fonts, and design systems change the look of the app.
- [Maps](/docs/maps) — how a place on an entry uses map and weather services.
- [Editor](/docs/editor) — how each entry is one document you write and reopen later.
