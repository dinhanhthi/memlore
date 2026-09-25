---
title: Editor
description: How each entry is its own page that saves as you write, and how two devices combine those edits.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/components/editor/Editor.tsx, src/components/editor/sharedExtensions.ts, src/components/editor/SlashMenu.tsx, src/components/editor/extensions/SlashMenu.ts, src/components/editor/extensions/MentionSuggestion.ts, src/components/editor/EntryTagsPill.tsx, src/components/editor/AttachmentStrip.tsx, src/components/editor/EditorFooter.tsx, src/components/layout/EditorPanel.tsx, src/lib/yjs.ts, src/components/common/EmotionPicker.tsx, src/components/common/emotions.ts, src/types/entry.ts, src/locales/en/editor.json, src/hooks/useEntryAttachments.ts, src-tauri/src/db/queries.rs, src-tauri/src/sync/entry_sync.rs, src-tauri/src/sync/metadata.rs, src-tauri/src/sync/engine.rs
---

# Editor

Each entry is one page, and that page belongs only to that entry. You write, leave, and come back to the same page. Memlore keeps it for you. You do not press a Save button.

## The page you write

The title sits at the top. The writing sits underneath.

On an empty line, type a slash to open a short menu. From there you can add a heading, a list, a checklist, a quote, a code block, a photo, a divider, or the date. Familiar marks work too, such as # for a heading.

You can also insert a table, place a video or a voice recording in the writing, and mention another entry by typing @. A find bar searches the page you have open.

Buttons that suggest a title, or otherwise use AI, stay off until you turn AI on. They are not part of saving the page.

## One document, saved as you go

Opening an entry loads that entry's own document. What you type is not copied into a different entry.

After you pause for about a second and a half, Memlore writes the page and the title into the journal on this device. If you switch entries sooner, it writes whatever was still waiting. A mood or a tag is written when you set it, not after that pause.

With the document, Memlore keeps a plain copy of the words. Search uses that copy. How search works is on [Search and media](/docs/search-and-media).

If a write fails, the app shows the error. It does not pretend the page was saved.

The page stays on this device unless you turn sync on.

## Edits from two devices

You are not sharing one cursor. Each device keeps its own copy. Those copies join only when [sync](/docs/sync) is on.

The page is a log of small changes: something added, or something taken out. The logs combine in any order. Apply this device's changes first or the other device's changes first, and you still get the same page. A later save does not throw away sentences the other device already wrote.

The title, the mood, and the tags are not in that log. For those, the newer change replaces the older one.

If both devices rewrote the same sentence, the two logs are joined. Memlore does not pick a tidy winner. You may need to clean that sentence up yourself.

## Mood and tags

You can mark how an entry feels: Not good, So-so, or Good. Those are the only three, stored as bad, neutral, and good. There is no stronger or weaker step, and no longer list. You can clear the mark. Memlore will not store any other mood.

Tags are labels you add or remove on that entry. You can reuse one you already have, or make a new one. They sit beside the page. They are not part of the sentences.

## Photos, video, and files

A photo, a video, or a recording can sit in the writing. The page remembers which file it is. The file itself is stored with the entry, not inside the sentences.

You can also keep a photo or a video beside the writing, and attach other files, such as a PDF. They show in a strip under the page, where you can look at them or save a copy. Where those files live is on [Search and media](/docs/search-and-media).

## What this means for you

Here is what you can count on, and what Memlore **cannot** do.

- You do not press Save. After a short pause, the page and the title are written on this device. Leaving the entry writes anything still waiting.
- Memlore **cannot** keep keystrokes from that pause if the app quits before the write finishes.
- One entry is one document. It does not mix with another entry's page.
- With sync on, writing from two devices combines. The log of small changes can be applied in any order, and both devices end up with the same page.
- Memlore **cannot** turn two rewrites of the same sentence into one tidy paragraph. You may have to fix that spot.
- Memlore **cannot** blend a mood or a set of tags. The later change replaces the earlier one. Two devices that add different tags do not keep both sets.
- There is no shared cursor. The other device sees your writing after sync, not while you are still typing.

How the sealed copies move is on [Sync](/docs/sync). How the words and the files are found later is on [Search and media](/docs/search-and-media).
