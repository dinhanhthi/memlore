---
title: How privacy works
description: What stays on your device, and what leaves only when you turn a feature on.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/tauri.conf.json, src-tauri/src/commands/updater.rs, src/hooks/useUpdater.ts, src-tauri/src/sync/gdrive_oauth.rs, src-tauri/src/sync/gdrive_provider.rs, src-tauri/src/commands/ai_provider.rs, src-tauri/src/ai/on_device/llm_catalog.rs, src-tauri/src/ai/on_device/server_binary.rs, src-tauri/src/utils/geocoding.rs, src/types/geocoding.ts, src-tauri/src/utils/weather.rs, src-tauri/src/commands/basemap.rs, src/components/map/LeafletMap.tsx, src/lib/mapkitLoader.ts, src-tauri/src/commands/fonts.rs, website/tokens.css
---

# How privacy works

Your journal lives on your device. Memlore has no server that stores it. The app does not send telemetry or analytics.

The dotted arrows in the picture are switches. Nothing goes out on an arrow until you turn that switch on. There is no arrow to Memlore.

:::diagram privacy

## Your journal stays on this device

Your entries sit in an encrypted database on this device. You do not create a Memlore account. You can write with no internet connection.

Memlore cannot open that database and read it. Search, locks, and the editor stay on the device with your journal.

## There is no Memlore server

No Memlore computer sits between you and your journal. The app does not include telemetry, analytics, advertising, or tracking.

Memlore also cannot see traffic you send to a service you picked. That traffic goes to that service, not to Memlore.

## What can leave your device

Each path below stays off until you turn it on, except the update check. You can turn that check off too.

### Sync

Sync stays off until you turn it on. You pick one place. That place is your Google Drive, or your iCloud Drive on a Mac.

Google Drive talks to Google at accounts.google.com, oauth2.googleapis.com, and www.googleapis.com. Memlore asks only for a hidden app folder. It cannot read your other Drive files. Entries are encrypted on your device before they upload. A short list of ids, times, deletion flags, and your device name is stored so your other devices know what to fetch. That list is not your journal text.

iCloud Drive uses the iCloud folder already on your Mac. The app does not sign in to Apple. It does not store an Apple password. Apple does not get your journal in the clear.

### AI

AI stays off until you opt in. An on-device model runs on this computer after you download it. Ollama and LM Studio do not always stay on this computer. Memlore calls an address local when it is this computer, when the name ends in .local, when it is a private network address (10., 172.16. through 172.31., or 192.168.), or when it is a private IPv6 address that starts with fc or fd. A local address does not ask for the privacy notice. The helper still receives your journal text. Ollama on another computer on your network is one example.

If you download an on-device chat model, the model file comes from huggingface.co. The program that runs it comes from github.com. Your journal text is not part of that download.

If you pick a hosted provider, the text you send goes to that provider. Memlore does not run that service. The built-in hosted choices are OpenAI (api.openai.com), Anthropic (api.anthropic.com), Google Gemini (generativelanguage.googleapis.com), xAI (api.x.ai), OpenRouter (openrouter.ai), Together (api.together.xyz), Groq (api.groq.com), and Voyage (api.voyageai.com). You can also type another address.

### Maps and weather

Maps and place search run only when you use them. Weather runs when an entry has a place.

You can download an offline map. That file comes from a Cloudflare R2 address. If that download fails, the app tries a copy on GitHub. After that, the map is read on this device.

If you choose MapTiler, map pictures come from api.maptiler.com. If you choose Apple MapKit, the map script comes from cdn.apple-mapkit.com.

Place search uses the provider you pick. Photon (photon.komoot.io) is the default. You can switch to Nominatim (nominatim.openstreetmap.org), Mapbox (api.mapbox.com), MapTiler (api.maptiler.com), or Google (maps.googleapis.com). The app sends the place you typed, not your entry text.

Weather comes from Open-Meteo at api.open-meteo.com. Older days use archive-api.open-meteo.com. The app sends the location and the date, not your journal.

### Update check

The app asks GitHub if a newer version exists. That check runs when you open the app, unless you turn it off. You can still check by hand later.

The usual check reads a release file on github.com. The address is https://github.com/dinhanhthi/memlore/releases/latest/download/latest.json. A beta check also asks api.github.com. GitHub does not receive your journal. This check is not telemetry.

### Fonts

The fonts that ship with the app are already on your device. They are not fetched while you write.

If you add a Google font, the app downloads that font. The font list comes from www.googleapis.com. At download time the app can also read a stylesheet from fonts.googleapis.com, and the font file comes from fonts.gstatic.com. Your journal is not sent with it.

## What this means for you

### What can leave

- Encrypted copies, plus a short sync list, if you turn sync on
- Text you choose to send, if you turn on a hosted AI provider
- Journal text sent to a helper on another computer on your own network, if you point AI there. That path does not ask for the privacy notice
- A model file, if you download on-device AI
- A place search, map pictures, or the weather for a date, if you use places
- A version check to GitHub, unless you turn that check off
- A font file, if you download a Google font

### What never leaves

- Your journal, while those switches stay off
- Telemetry, analytics, or advertising
- A Memlore account, because there is not one
- Your journal text, sent to Memlore
- An Apple password for iCloud
- Your other Google Drive files

### What Memlore cannot do

- Read your journal
- Store your journal on a Memlore server
- See what you send to Google, Apple, or an AI provider
- Sell your data, or use it for ads
- Open Drive files outside the hidden app folder

Read the next pages for the detail: [encryption](/docs/encryption), [locks](/docs/locks), [sync](/docs/sync), [AI](/docs/ai), and [maps](/docs/maps).
