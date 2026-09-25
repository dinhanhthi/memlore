---
title: Locks
description: How the app lock, an invisible vault, and a second lock hide entries without a second encryption layer.
updated: 2026-09-25
sources: website/src/legal/privacy.md, website/tokens.css, src-tauri/src/utils/second_lock.rs, src-tauri/src/utils/invisible_lock.rs, src/stores/invisibleLockStore.ts, src/stores/secondLockStore.ts, src/hooks/useSecondLockAutoLock.ts, src/hooks/useInvisibleLockAutoLock.ts, src/hooks/useAuth.ts, src/lib/lock.ts, src-tauri/src/db/queries.rs, src-tauri/src/commands/second_lock.rs, src-tauri/src/commands/export.rs, src-tauri/src/commands/ai.rs, src-tauri/src/commands/ai_memory.rs, src-tauri/src/commands/search.rs, src-tauri/src/ai/provider.rs, src-tauri/src/ai/indexer.rs, src-tauri/src/sync/engine.rs, docs/plans/archived/2026-06-28-invisible-lock/README.md, docs/plans/archived/2026-06-28-second-lock-entries-journals/README.md, docs/plans/archived/2026-06-29-lock-sync-propagation/README.md, docs/plans/archived/2026-08-12-invisible-multi-vault/README.md
---

# Locks

Memlore can hide your writing in three ways. They are not three safes stacked inside each other.

Think of the app lock as the front door of the house. Once you are inside, an invisible vault and the second lock are two rooms side by side. The second lock is a clasp on a diary. It is not a second safe, and it is not a second encryption. The words stay in the same journal described in [Encryption](/docs/encryption).

An item is one or the other, never both. Marking a journal or an entry invisible clears its second lock. The app stores that item as not second-locked.

:::diagram locks

## The app lock

This is the password that opens Memlore on this device. Until you unlock, you get the unlock screen. The journal is not loaded.

You can lock it again yourself. Closing the app also drops the key it was holding in memory. On a Mac you can turn on Touch ID. Touch ID only unlocks. It does not replace the password.

There is no idle timer on this lock. Leave the window open and the journal stays open. The timers further down belong to the other two locks.

While the app is locked, lists, search, AI, and export do not run. Export refuses until the key is loaded. The screen does not show entries.

What it does not do:

- It does not hide one entry from you after you have unlocked. That is the other two locks.
- It does not lock itself after a few idle minutes.
- Locking the window does not, by itself, close an invisible vault or a second-lock session you already opened. Those close on their own timer, when you lock them, or when you quit the app.
- It is the encryption for the whole database. It is not a hide switch for a single page. The details are on [Encryption](/docs/encryption).

## Invisible vaults

An invisible vault is a hidden room with its own password. You can have more than one. Each password opens only its vault. Only one vault is open at a time. Opening another closes the first.

While a vault is closed, its journals and entries do not appear. Lists, search, and the calendar behave as if they are not there. Other vaults stay hidden even when one vault is open.

Typing a password either opens the matching vault or creates a new empty one. The app does not tell you which happened.

You can hide one entry, or a whole journal. A hidden journal keeps its already-hidden entries in that same vault. Marking something invisible turns the second lock off on it.

Idle time can close the open vault. The timer starts at 5 minutes. You can pick 1, 5, 15, or 30 minutes, or never. Moving the mouse, typing, clicking, or scrolling starts the wait over.

Where a closed vault stays out:

- Lists and search omit it. Search can see only the vault you have open.
- AI that scans the journal leaves every invisible vault out, even the one you have open. Turning on "include locked entries" does not change that.
- The entry list and a plain-text export leave invisible vaults out, whether a vault is open or not. A full Memlore zip still contains that writing in the database snapshot, as readable text. Photos and files from those entries are in the zip too, as ordinary files. They are not locked again.

What it does not do:

- It does not encrypt that writing with the vault password. The check is the same kind of password check as the second lock. The text stays in the same journal database.
- It does not sit inside the second lock. If both would apply, invisible wins and the second lock is cleared.
- There is no reset. Forget a vault password and the app cannot open that vault again.
- It does not remove the Invisible lock section from Settings. The feature can still be found. A closed vault's entries cannot.

## The second lock

The second lock is one extra password, different from the app password. You mark chosen entries, or a whole journal. One password opens every second-locked item for that sitting. A locked journal can still show in your journal list. Its entries count as locked until you enter the password.

**This is a password gate, not a separate encryption layer.** The app stores a check of the password. It does not seal the entry with its own key.

While that sitting is closed, those entries drop out of lists and out of search. If you turn on "show existence," you still see a blank placeholder. The date stays. The title, the writing, the place, the weather, and the emotion are blank. Search still skips them.

Open the sitting and the writing shows again. Search can find it again, including meaning search. Idle time closes the sitting. The choices are the same as the invisible vault: 1, 5, 15, or 30 minutes, or never. The start is 5 minutes.

Where it hides things:

- Lists, the calendar, and the media gallery stay empty of that writing, or show only the blank placeholder.
- Keyword search and meaning search skip it until the sitting is open.
- Chat, summaries, and emotion suggestions do not send the text of a second-locked entry, even after you have opened the sitting. Background indexing and Memory can include it only if you turn that option on. A hosted provider can then receive that text. Invisible entries are still left out. See [AI](/docs/ai).
- An export of the journal does include second-locked entries. The export file is not protected by this password.

What it does not do:

- It does not scramble the entry with a second key. Someone who can already open the encrypted journal is not stopped by another cipher. The password only decides what the app shows.
- It does not cover an invisible item. Invisible clears the second lock.
- There is no recovery phrase for this password. Forget it and the app will not show those entries again. The rest of the journal still opens with your device password.
- A mention can copy a locked title into another entry if you turn that option on. It is off unless you enable it. That title then lives in the other entry, where search and AI can see it.

A lock flag can sync to your other devices with the entry. That still does not add a second encryption. If the synced copy is invisible, it is stored as invisible and not second-locked.

## What this means for you

- Unlock the app first. The other two locks only matter after that door is open.
- Use an invisible vault when a journal should not show up at all. Use the second lock when a blank placeholder is enough to remind you something is there.
- Neither extra password is a second encryption. Both are checks the app makes before it shows those entries. The journal file is still the one in [Encryption](/docs/encryption).
- Forget an extra password and the app has no reset for it. Forget the device password and you still need the recovery words from that encryption page.
- The entry list and a plain-text export leave invisible vaults out. A full Memlore zip still contains that writing in the snapshot, and their photos and files are in the zip as ordinary files, not locked again. An export includes second-locked entries. Do not treat an export as hidden.
- AI that scans the journal skips invisible vaults. It also skips second-locked text in chat, summaries, and emotion suggestions, unless you opted in for indexing or Memory. Facts saved that way can still surface later. [AI](/docs/ai) is the longer account.
