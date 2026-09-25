---
title: Memory
description: How Memlore keeps short facts about you, and which model reads your writing to make them.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/commands/ai_memory.rs, src-tauri/src/ai/memory_extractor.rs, src-tauri/src/ai/provider_registry.rs, src-tauri/src/db/memory.rs, src-tauri/src/db/schema.rs, src-tauri/src/sync/engine.rs, src/components/settings/MemoriesSettings.tsx, src/components/settings/AISettingsPanel.tsx, src/locales/en/ai.json
---

# Memory

Memory is an optional list of short facts about you. The app can draw them from your journal and from what you type in Daily Chat, then offer a matching fact when you chat. It stays off until you turn it on. It is not a second copy of your entries.

## What it remembers

Each fact is one short sentence about you. The aim is to keep what lasts:

- Who you are in a stable way, such as your work, your values, or a lasting condition
- Life milestones, such as a move, a career change, or a birth
- Important people and relationships
- Goals or commitments you have held for a long time

Passing things are meant to be left out: a mood, the weather, one meal, one workout, or a fleeting like. Journal entries can be read. In Daily Chat, only what you wrote is read. Replies from the assistant are not treated as facts about you.

## How a memory is created

Open AI settings and choose the Memory tab. Turn on Enable User Memory, then pick two models. One writes the facts. The other matches similar facts. Memory does not run until both are set. These are Memory's own models, separate from the model that answers Daily Chat. More on choosing a provider is on the [AI](/docs/ai) page.

An on-device model stays on this computer. A local address can be another computer on your network — a name ending in .local, a private network address, or a private IPv6 address — and that computer still receives the text. A hosted, subscription, or command-line provider receives it too. If you allow one of those, you also confirm a warning. During a scan, what is sent is the writing itself — the entry, or your words in Daily Chat — not only the short fact that is saved. Memlore does not run that provider and does not see that traffic.

While Memory is on, the app looks through recent entries and recent chats on its own. Editing an older entry puts that entry back in line for the next pass. You can also press Scan memories. That looks for new or changed writing, and it tidies the list: it can merge duplicates, combine related fragments, and drop trivia. Tidy runs only from that button, and at most once every 6 hours. Pressing it again sooner still looks for new writing, but skips the tidy.

On a scan, the writing model sees the entry or your chat words, plus a few related facts already saved. The matching model sees that same writing, so it can find those facts. On a tidy, the writing model sees the saved facts, not the original entries. A fact you have turned off is left out. So is a fact that came from an entry which is locked or invisible right now.

The same models can help build a writing [Persona](/docs/persona). That is a separate choice.

## Where they live

Facts are stored in the encrypted database on your device, with the rest of your journal. There is no Memlore server that keeps a copy. On-device stays on this computer, so the writing a scan reads stays there too. A local address can be another computer on your network — a name ending in .local, a private network address, or a private IPv6 address — and that computer still receives the text. A hosted, subscription, or command-line provider receives it too.

## How to view, change, or delete them

On the Memory tab, press Manage memories. You can search the list, rewrite a fact, turn one off, or delete one. Delete asks you to confirm. Opening the list does not start a scan.

Turning a fact off keeps it in the list. Daily Chat will not use it, and a tidy pass will not fold it into another fact. A fact you leave on can still be rewritten later, by a tidy or by a scan of newer writing.

Turning Enable User Memory off stops new scans and stops Daily Chat from using memories. The facts stay saved. The list is available again when you turn Memory back on, which is how you review or delete them.

## Whether they sync

Sync stays off until you turn it on. When it is on, memory text is encrypted on this device before it is uploaded, in the same way as your entries. An edit, a fact you turned off, and a fact you deleted travel with that copy, so your other devices can match.

## What this means for you

You choose whether Memory runs, and you can read every fact it keeps.

Locked entries are left out of a scan unless you turn on Include locked entries. That switch starts off. Invisible entries are always left out, whether the switch is on or off. With the switch on, a scan can send the raw text of a locked entry, and that entry can become a saved fact. The fact can show in your list. It is not fed into a [Persona](/docs/persona) while the entry it came from is locked or invisible. Include locked entries does not put that fact into the profile. If a Memory model is not on this computer, the full text of those locked entries is sent to that provider during a scan, not only the short fact.

Daily Chat still does not use a fact that came from an entry which is locked or invisible at that moment. To let chat use other facts, turn on Use Memory in Chat. You will find it inside Daily Chat on the Features tab, and it starts off. When it is on, a few matching facts are added to the reply, so the chat provider for that reply sees those short facts. The message you just typed is also sent to Memory's matching model, so it can choose them.
