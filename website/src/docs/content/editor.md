---
title: Editor
description: How each entry is its own page that saves as you write, and how two devices combine those edits.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/components/editor/Editor.tsx, src/components/editor/sharedExtensions.ts, src/components/editor/SlashMenu.tsx, src/components/editor/extensions/SlashMenu.ts, src/components/editor/extensions/MentionSuggestion.ts, src/components/editor/EntryTagsPill.tsx, src/components/editor/AttachmentStrip.tsx, src/components/editor/EditorFooter.tsx, src/components/layout/EditorPanel.tsx, src/lib/yjs.ts, src/components/common/EmotionPicker.tsx, src/components/common/emotions.ts, src/types/entry.ts, src/locales/en/editor.json, src/hooks/useEntryAttachments.ts, src-tauri/src/db/queries.rs, src-tauri/src/sync/entry_sync.rs, src-tauri/src/sync/metadata.rs, src-tauri/src/sync/engine.rs
---

# Editor

Each entry is its own page, and Memlore saves it for you without a Save button.

:::diagram editor

## Writing

- Type a slash on an empty line for headings, lists, photos, and more.
- AI buttons, such as suggesting a title, stay off until you turn AI on.
- A plain copy of the words is kept for search.

## Saving

- One entry is one document; what you type never lands in another entry.
- The page and title are written on this device about a second and a half after you stop.
- Mood and tags are written as soon as you set them.
- If the app quits before that write finishes, keystrokes from that pause are lost.
- If a write fails, the app shows the error.

## Two devices

- Copies join only when [sync](/docs/sync) is on, not live while you type.
- Page edits from both devices merge, so neither device's sentences are thrown away.
- If both rewrote the same sentence, both versions are joined and may need tidying.
- Title, mood, and tags keep the newer change, so different tags from two devices are not combined.

## Mood, tags, and files

- A mood is Not good, So-so, or Good, or none; no other mood is stored.
- Tags are labels beside the page, not inside the sentences.
- Photos, video, recordings, and other files are stored with the entry, not inside the page.
