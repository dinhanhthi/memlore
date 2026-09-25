---
title: Persona
description: How Memlore builds a private writing profile and uses it when AI writes for you.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src-tauri/src/ai/persona_builder.rs, src-tauri/src/commands/ai_memory.rs, src-tauri/src/commands/ai.rs, src-tauri/src/db/persona.rs, src-tauri/src/db/memory.rs, src-tauri/src/db/queries.rs, src-tauri/src/sync/engine.rs, src/components/settings/PersonaSettings.tsx, src/hooks/useMemoryIncludeProtected.ts, src/locales/en/ai.json
---

# Persona

A persona is a short writing profile that helps AI features write more like you.

:::diagram persona

## What it is used for

- **Continue writing** and **Rewrite** need **Use persona** on, which is the default.
- Turning the switch off keeps the text.
- The persona is not the Daily Chat friend style.
- With the switch on, Continue, Rewrite, and Save as entry send the saved profile to that step's AI, not the journal pieces again.

## What builds it

- Your optional answers, which win over saved facts.
- "Do not bring this up" in your answers is passed on as a hard rule.
- Allowed facts from [Memory](/docs/memory), and style from at least three eligible entries.
- Lines that copy long stretches of your wording are removed.

## What is left out

- Invisible entries, facts from them, and deleted pages are never used.
- Locked entries stay out unless Memory and **Include locked entries** are both on.
- Then locked text can be sent to the Memory provider on a rebuild.

## Refresh and what is sent

- **Rebuild persona** uses the Memory providers and asks first if you edited the notes.
- While Memory runs, unedited notes can refresh on their own, at most about once a day.
- On-device stays here; a helper on your network or a hosted provider gets the text.
- That text is your answers, allowed facts, and pieces of eligible entries.
- The profile stays in the encrypted journal; with sync on it is encrypted before upload.

## How to start over

- There is no separate erase button.
- Turn **Use persona** off, delete a section's text, or rebuild.
