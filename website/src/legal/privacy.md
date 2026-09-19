---
title: Memlore — Privacy Policy
description: How Memlore treats your journal: it stays on your device, with no Memlore server, no telemetry, and optional cloud and AI that you control.
updated: 20 September 2026
---

# Privacy Policy

Memlore is a private journal. This page explains what the app and this website do with information — and what they never do.

## Who we are

Memlore is made by [Anh-Thi Dinh](https://dinhanhthi.com). It is an open-source journal app. Questions: [contact@memlore.app](mailto:contact@memlore.app).

## What we do not collect

There is no Memlore server and no Memlore account. The app does not watch you.

- No telemetry
- No analytics
- No advertising
- No tracking pixels

## Your journal on your device

Your journal lives on your device, in an encrypted local database. We cannot read it.

## Optional cloud sync

Sync stays off until you turn it on. You pick one place — your Google Drive or your iCloud Drive. There is no Memlore server in between.

Entries, media, and settings are encrypted on your device before they are uploaded. A small sync list and device registry — IDs, timestamps, deletion flags, and your device name, not journal text — are stored as JSON so your other devices know what to pull.

## Optional Google Drive sync

If you choose Google Drive, you connect your own Google account. Memlore asks only for the [drive.appdata](https://www.googleapis.com/auth/drive.appdata) scope. Synced files sit in Google Drive’s hidden Application Data folder — not visible on drive.google.com — and Memlore cannot read your other Drive files.

The refresh token, your Google account email, and your Drive storage quota stay only in the encrypted database on this device, so the app can show which account is connected. They stay until you disconnect, then they are deleted from the local database. The access token stays in memory, is never written to disk, and is gone when the app closes.

Disconnecting in the app does not delete the files already in your hidden Application Data folder. To remove that Google-side copy, open Google Drive → Settings → Manage apps → Memlore → Disconnect from Drive.

Google user data is used only to run the Drive sync you turned on. No human at Memlore reads your Google user data. There is no Memlore server for it to reach. Memlore does not:

- Sell it, or transfer it to data brokers or information resellers
- Use it for advertising, including targeted, personalized, or interest-based ads
- Use it to develop, improve, or train generalized or non-personalized AI or ML models
- Use it for credit-worthiness, lending, or any other determination unrelated to the app's features
- Transfer it to third parties, except as needed to operate Drive sync inside your own Google account, or where required by law

Memlore's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Optional iCloud Drive

If you choose iCloud Drive (on a Mac), Memlore writes to a Memlore folder in your iCloud Drive — the same iCloud Drive you already see in Finder.

Memlore does not sign in to Apple for you and does not store an Apple password or iCloud token. It uses the iCloud Drive session already on this Mac.

The same encrypted payloads and JSON sync list described above go into that folder. Apple does not receive your journal in the clear. Apple’s iCloud terms apply.

You can disconnect in the app. Disconnecting does not delete the Memlore folder in iCloud Drive. Remove that folder yourself if you want the cloud copy gone.

## Optional AI

AI stays off until you opt in and accept a privacy notice. You choose the provider — local or on-device, or a hosted one.

If you pick a hosted provider, the text you send it goes to that provider. Memlore does not run those services and does not see that traffic.

## Optional maps, places, and speech

Maps, geocoding, and speech-to-text run only if you turn them on. They talk to the provider you choose — for example Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit, or your speech-to-text provider.

## App updates

The app may request GitHub release metadata so it can tell you when an update is available. That check is not telemetry.

## This website

This marketing website does not set analytics cookies and does not collect journal data. The interactive demo uses sample data only.

The Download button is the one exception, and it is worth being precise about. It goes through dl.memlore.app, which counts the download and then sends you on to the file on GitHub. What gets recorded is the time, the app version, and the country Cloudflare infers from the connection. No IP address is stored and no cookie is set. It happens when you download the app, never while you use it — the app itself still sends nothing, ever.

## Changes

This policy may change. The date at the top of the page shows when it was last updated.

## How to reach us

Privacy questions: [contact@memlore.app](mailto:contact@memlore.app).
