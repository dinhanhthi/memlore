---
title: Persona
description: How Memlore builds a private writing profile and uses it when AI writes for you.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/ai/persona_builder.rs, src-tauri/src/commands/ai_memory.rs, src-tauri/src/commands/ai.rs, src-tauri/src/db/persona.rs, src-tauri/src/db/memory.rs, src-tauri/src/db/queries.rs, src-tauri/src/sync/engine.rs, src/components/settings/PersonaSettings.tsx, src/hooks/useMemoryIncludeProtected.ts, src/locales/en/ai.json
---

# Persona

A persona is a short writing profile. It helps AI features write more like you.

It is not the friend style you pick for Daily Chat. That choice only changes the conversation. This profile is for journal text.

## What it is used for

You turn it on or off with **Use persona**. Open Settings, then AI, then Persona. The switch starts on.

While it is on, these actions can follow the profile:

- Continue writing in the editor
- Rewrite a selection in the editor
- Save a Daily Chat as an entry

The profile is added to the instructions for that step. It does not replace the page you are writing.

Continue writing and Rewrite need the switch on. If you turn it off, those two stop. Save as entry still works, but it will not follow the profile.

Turning the switch off keeps the text. It does not delete it.

If the profile is still empty, turning it on does not change how the AI writes.

## How it is built

You can answer a few optional questions. Your answers count more than saved facts. If an answer disagrees with a fact, your answer wins. If you say the AI should not bring something up, the profile is told to treat that as a hard rule.

Memlore can also write two notes:

- Traits and preferences, from your answers and from facts in [Memory](/docs/memory) that are still allowed
- Writing style, from your journal entries

The style note needs at least three eligible entries. It describes how you write, such as length, tone, and mixing languages. It is a description, not quotations from your pages. A line that repeats a long stretch of your wording is removed. If too much of the note is copied, that rebuild is not saved.

**Rebuild persona** is on the same screen. It needs the Memory providers. Your answers stay. The two generated notes are replaced. If you edited those notes, the app asks before it replaces them.

If you have not edited them, and Memory is running, Memlore can refresh the profile after your saved facts change. It will not do that more than about once a day. Your own edits are left alone until you confirm a rebuild.

## What is left out

Invisible entries are never used. They are not used for the style note. Facts that came from them are not used in the profile.

Locked entries are left out of the style note unless two switches are on. Memory must be on, and **Include locked entries** must be on. That second switch is in Memory settings. It stays off until you turn it on. While both are on, recent locked entries can shape the style note. Their text can be sent to the Memory provider when the profile is rebuilt.

A saved fact that came from a journal page is left out while that page is locked or invisible. **Include locked entries** does not put that fact back into the profile.

Deleted pages are not used.

[AI](/docs/ai) explains what a provider receives. [Memory](/docs/memory) explains saved facts.

## Where it stays

The profile is stored in the encrypted journal on this device. There is no Memlore server that can read it.

If sync is on, the profile is encrypted on your device and uploaded with your Memory data. Your other devices can then use the same profile.

Building it uses the provider you chose for Memory. On-device stays on this computer. A local address can be another computer on your network — a name ending in .local, a private network address, or a private IPv6 address — and that computer still receives the text. A hosted, subscription, or command-line provider receives it too. That text is your answers, the allowed saved facts, and pieces of eligible entries. Memlore does not run a hosted service and does not see that traffic.

When you continue, rewrite, or save a chat as an entry, the saved profile goes with that request. The journal pieces used to build the style note are not sent again for that step.

## How to start over

There is no separate erase button.

- Turn **Use persona** off to stop the AI from using the profile. The text stays.
- Edit your answers, Traits and preferences, or Writing style. You can clear a section by deleting its text and saving.
- Choose **Rebuild persona** to replace the two generated notes. Your answers stay. If you edited those notes, confirm before they are replaced.

## What this means for you

You choose whether AI writes in this voice. The switch starts on. You can turn it off without losing the text.

Your answers outrank guesses from your journal. You can correct the notes, or stop using them, without deleting your entries.

Invisible pages stay out. Locked pages stay out of the style note unless you turn on Memory and Include locked entries. Even then, a fact from a page that is locked right now is not added to the profile.

The profile lives in your encrypted journal. A provider off this machine only sees the text for a step you run, such as a rebuild or a writing action.
