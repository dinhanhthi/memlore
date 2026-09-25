---
title: Locks
description: How the app lock, an invisible vault, and a second lock hide entries without a second encryption layer.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/utils/second_lock.rs, src-tauri/src/utils/invisible_lock.rs, src/stores/invisibleLockStore.ts, src/stores/secondLockStore.ts, src/hooks/useSecondLockAutoLock.ts, src/hooks/useInvisibleLockAutoLock.ts, src/hooks/useAuth.ts, src/lib/lock.ts, src-tauri/src/db/queries.rs, src-tauri/src/commands/second_lock.rs, src-tauri/src/commands/export.rs, src-tauri/src/commands/ai.rs, src-tauri/src/commands/ai_memory.rs, src-tauri/src/commands/search.rs, src-tauri/src/ai/provider.rs, src-tauri/src/ai/indexer.rs, src-tauri/src/sync/engine.rs, docs/plans/archived/2026-06-28-invisible-lock/README.md, docs/plans/archived/2026-06-28-second-lock-entries-journals/README.md, docs/plans/archived/2026-06-29-lock-sync-propagation/README.md, docs/plans/archived/2026-08-12-invisible-multi-vault/README.md
---

# Locks

Memlore can hide writing in three ways, side by side rather than stacked.

:::widget locks-explorer

## Three locks

:::cards

- **App lock** — Opens Memlore with your device password. Until you unlock, the journal is not loaded. It is the [encryption](/docs/encryption).
- **Invisible vault** — Hides entries or journals behind its own password. One opens at a time; the others stay hidden.
- **Second lock** — Guards chosen entries or journals. One password opens them all for that sitting.

:::

## What stays hidden

- A closed vault's journals and entries do not appear in lists, search, or the calendar.
- Second-locked entries drop out of lists and search.
- With "show existence" on, a blank placeholder keeps the date.
- An item is invisible or second-locked, never both; invisible wins.

## Limits

- Both extra passwords are checks, not a second encryption.
- A forgotten extra password has no reset.
- Idle time can close a vault or sitting, never the app lock.
- Locking the window leaves an open vault or sitting open.
- The Invisible lock section stays in Settings, so the feature can be found; a closed vault's entries cannot.
- A typed password opens the matching vault or creates a new empty one; the app does not tell you which.

## Export

- An export includes second-locked entries, unprotected.
- A full Memlore zip holds invisible-vault writing as readable text, plus its files.

## AI

- AI that scans the journal skips every invisible vault, even an open one.
- Chat and summaries skip second-locked text, even in an open sitting.
- Indexing and Memory can include it only if you turn that on; a hosted provider can then receive that text, and facts saved that way can still surface later. See [AI](/docs/ai).
- An opt-in mention setting can copy a locked title into another entry, where search and AI see it.
