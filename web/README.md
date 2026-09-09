# Memlore Web Preview Harness

A browser-based preview of the Tauri app UI that mounts the **exact same** `src/App.tsx`
with the Tauri backend replaced by a mocked IPC layer and selectable fake-data scenarios.

## Quick start

```
pnpm web:dev   # starts at http://localhost:5175
```

## The golden rule

**Never edit `src/` components to accommodate the browser.** If a component breaks in the browser,
fix the mock layer (`web/mocks/`) instead. Any change you see at `localhost:5175` is the exact
change that ships in the Tauri app.

## How it works

Every `@tauri-apps/*` import in `src/` is aliased by Vite to a mock in `web/mocks/`:

| Import                   | Mock                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `@tauri-apps/api/core`   | `web/mocks/core.ts` — `invoke()` delegates to `invokeRouter.ts` |
| `@tauri-apps/api/event`  | `web/mocks/event.ts` — in-memory listener registry              |
| `@tauri-apps/api/window` | `web/mocks/window.ts` — no-op window controls                   |
| ...                      | ...                                                             |

The **scenario registry** (`web/scenarios/index.ts`) lets you declaratively define which IPC
commands return what data, which Tauri events to fire on load, and any Zustand store seeds.

## Scenarios

Select a scenario from the floating dev panel (top-right). URL-persist with `?scenario=<id>`.

| ID                                 | Screen                                             |
| ---------------------------------- | -------------------------------------------------- |
| `locked`                           | LockScreen — password unlock                       |
| `onboarding`                       | WelcomeScreen                                      |
| `force-re-pair`                    | ForceRePairScreen                                  |
| `onboard-new-device`               | OnboardNewDeviceScreen — recovery phrase step      |
| `onboard-new-device-unlock-method` | OnboardNewDeviceScreen — unlock method step        |
| `onboard-new-device-password`      | OnboardNewDeviceScreen — set device password step  |
| `logged-in-empty`                  | TwoPanelLayout, no entries                         |
| `logged-in`                        | TwoPanelLayout, 20 entries + media + stats         |
| `loading`                          | Every page frozen on its loading placeholder       |
| `sync-off`                         | Logged in, sync disabled                           |
| `gdrive-connected`                 | Logged in, Google Drive connected (no sync yet)    |
| `syncing`                          | Logged in, sync animating                          |
| `synced`                           | Logged in, GDrive connected, last synced 5 min ago |
| `sync-error`                       | Logged in, sync error banner                       |
| `scope-upgrade`                    | Logged in, Drive scope upgrade banner              |
| `gdrive-settings-collapsed`        | Settings → Sync, connected (recovery wizard)       |
| `gdrive-recovery-active`           | Active recovery progress; Sync now disabled        |
| `gdrive-sync-error-network`        | Network error; help does not auto-expand           |

Playwright recovery UX (mocked harness, no Google OAuth):

```
pnpm exec playwright test e2e/sync-recovery.spec.ts
```

## Adding a scenario

1. Add an entry to `scenarios[]` in `web/scenarios/index.ts`
2. Set `invoke` overrides for any IPC commands you want to control
3. Optionally add `emitOnLoad` events (see `web/scenarios/sync.ts` for examples)
4. Optionally add `seedStores` to seed Zustand stores before mount

## Adding fixtures

Add typed arrays to `web/fixtures/` and import them in `web/fixtures/index.ts`.
The `web/scenarios/index.ts` `logged-in` scenario's invoke factories reference them.

## Build gate

```
pnpm web:build   # tsc --noEmit + vite build
```
