---
title: Search and media
description: How word search, meaning search, and attached photos and video stay on your device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/db/schema.rs, src-tauri/src/db/queries.rs, src-tauri/src/db/embeddings.rs, src-tauri/src/commands/search.rs, src-tauri/src/commands/media.rs, src-tauri/src/sync/media_sync.rs, src-tauri/src/sync/embedding_sync.rs, src-tauri/src/ai/providers/on_device_embed.rs, src-tauri/src/utils/image_compression.rs, src-tauri/src/utils/video_compression.rs, src-tauri/src/utils/thumbnail.rs
---

# Search and media

You can look through your journal in two ways. One matches the words you type. The other matches what a passage is about. Photos, video, and other files you attach stay on this device unless you turn sync on.

## Finding a word

Word search runs inside the encrypted database on your device. It looks at each entry's title and the text you wrote. It does not look inside a photo, a video, or another attached file.

The database is scrambled on disk. This search runs only after the app is unlocked, and the words you type are not sent anywhere.

Accents do not block a match. If you leave them off, the same word can still be found. Entries you have deleted are left out. While a lock or a hidden journal is closed, those entries stay out of the results. After you open that lock, they can appear.

## Finding by meaning

Meaning search is separate, and you can turn it off. Memlore splits your writing into passages and turns each one into a fingerprint of what a passage means. Your question gets a fingerprint too. You see the passages whose fingerprints are closest to the question.

You choose who makes that fingerprint. It can be an on-device model. You download that model once. After that, making a fingerprint stays on this computer and does not use the network. Or it can be a provider you picked. If that provider is on the internet, the passage text and the question you type are sent to it. Memlore does not run that provider and does not see that traffic.

The fingerprints are kept in the same encrypted database. You choose who makes them. The privacy notice is required only when that helper is classified as remote or subscription. An on-device model and a local address do not ask, and a local helper still receives the text. A local address is this computer, a name that ends in .local, a private network address, or a private IPv6 address. Ollama on another computer on your home network is one case. Hidden entries are never fingerprinted, even when that vault is open. Locked entries are left out unless you turn on Include locked entries. You do not have to open the second lock for that. The helper receives the passage text when the fingerprint is made, before you reveal the entry. If sync is on, the fingerprints are sealed and copied with your journal, so another device using the same choice does not have to send those passages again.

## Where photos and video are kept

When you add a photo, a video, or another file, Memlore copies it into a media folder on this device. The encrypted database remembers which entry it belongs to. The picture and video bytes themselves are ordinary files in that folder. They are not stored inside the database.

Sync stays off until you turn it on. You pick one place: your Google Drive, or iCloud Drive on a Mac. Before a file is uploaded, Memlore scrambles it on this device. The file in the cloud is that sealed copy. Another device can open it only with your key. When a small preview exists, it is sealed and uploaded the same way, so the other device can show it without fetching the full file.

## Previews and size

For common photo types, Memlore saves a small preview beside the original. On a Mac it can also save a still frame from a video. Other attached files do not get a preview. If a preview cannot be made, the photo or video is still kept.

You can choose how hard Memlore squeezes photos. A photo already under the size limit can be left as it is. A photo over the limit is squeezed until it fits, or it is not added. Some photo formats cannot be squeezed at all, and those are kept as they are unless they are over the limit. The usual photo limit is 5 MB. The usual video limit is 100 MB, and a video over it is not added. You can change either limit, or remove it. Another kind of file over 50 MB is not added.

On a Mac, a video under the limit can be made smaller, and only when the new file is actually smaller than the original. You can leave Mac videos as they are. On Windows and Linux the video is stored unchanged.

## What this means for you

- Word search never leaves your device. Memlore **cannot** find a photo by what is in the picture, or read the words inside an attached file.
- Meaning search compares a fingerprint of what a passage means. An on-device model keeps that work on this computer. A local helper still receives the text, and that path does not ask for the privacy notice. The notice is required only when the helper is classified as remote or subscription.
- Memlore **cannot** stop that provider from reading the text you sent it.
- Memlore **cannot** scramble the photo and video files in the media folder on this device. Someone who can open that folder can open the files without your journal password.
- If you sync, the copy in Google Drive or iCloud is scrambled before it leaves.
- Memlore **cannot** shrink videos on Windows or Linux. Those clips stay the size you added.
- Word search, and the results of meaning search, leave a closed lock and a hidden journal out until you open them. Making a fingerprint is separate. Hidden entries are never included. Locked entries are included only when Include locked entries is on, and that does not wait until you open the second lock. A cloud helper then receives the passage text. [AI](/docs/ai) and [Locks](/docs/locks) describe that switch.

Who makes a fingerprint is covered in [AI](/docs/ai). How sealed files move between your devices is covered in [Sync](/docs/sync).
