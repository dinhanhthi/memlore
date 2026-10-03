# Memlore Mockup Harness

A browser-based preview of the Tauri app UI that mounts the **exact same** `src/App.tsx`
with the Tauri backend replaced by a mocked IPC layer and selectable fake-data scenarios.

## Quick start

```
pnpm mockup:dev   # starts at http://localhost:5175
```

## The golden rule

**Never edit `src/` components to accommodate the browser.** If a component breaks in the browser,
fix the mock layer (`mockup/mocks/`) instead. Any change you see at `localhost:5175` is the exact
change that ships in the Tauri app.

## How it works

Every `@tauri-apps/*` import in `src/` is aliased by Vite to a mock in `mockup/mocks/`:

| Import                   | Mock                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `@tauri-apps/api/core`   | `mockup/mocks/core.ts` — `invoke()` delegates to `invokeRouter.ts` |
| `@tauri-apps/api/event`  | `mockup/mocks/event.ts` — in-memory listener registry              |
| `@tauri-apps/api/window` | `mockup/mocks/window.ts` — no-op window controls                   |
| ...                      | ...                                                                |

The **scenario registry** (`mockup/scenarios/index.ts`) lets you declaratively define which IPC
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

1. Add an entry to `scenarios[]` in `mockup/scenarios/index.ts`
2. Set `invoke` overrides for any IPC commands you want to control
3. Optionally add `emitOnLoad` events (see `mockup/scenarios/sync.ts` for examples)
4. Optionally add `seedStores` to seed Zustand stores before mount

## Adding fixtures

Add typed arrays to `mockup/fixtures/` and import them in `mockup/fixtures/index.ts`.
The `mockup/scenarios/index.ts` `logged-in` scenario's invoke factories reference them.

## Build gate

```
pnpm mockup:build   # tsc --noEmit + vite build
```
