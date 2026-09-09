import { useEffect, type ReactNode } from 'react'
import { LockScreen } from './components/auth/LockScreen'
import { BootFileCorruptScreen } from './components/auth/BootFileCorruptScreen'
import { ForceRePairScreen } from './components/auth/ForceRePairScreen'
import { ReconnectDriveScreen } from './components/auth/ReconnectDriveScreen'
import { WelcomeScreen } from './components/auth/WelcomeScreen'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'
import { OnboardingCelebrationModal } from './components/onboarding/OnboardingCelebrationModal'
import { LiveAnnouncer } from './components/common/LiveAnnouncer'
import { GdriveConnectToaster } from './components/GdriveConnectToaster'
import { TwoPanelLayout } from './components/layout/TwoPanelLayout'
import { TitleBar } from './components/layout/TitleBar'
import { FooterBar } from './components/layout/FooterBar'
import { WindowDragRegion } from './components/layout/WindowDragRegion'
import { QuitConfirmDialog } from './components/layout/QuitConfirmDialog'
import { SearchOverlay } from './components/search/SearchOverlay'
import { CommandPalette } from './components/palette/CommandPalette'
import { EmbeddingExplainerPanel } from './components/ai/EmbeddingExplainerPanel'
import { AdoptedAiSetupModal } from './components/ai/AdoptedAiSetupModal'
import { EmbeddingSyncDecisionModal } from './components/ai/EmbeddingSyncDecisionModal'
import { ModelWarmupModal } from './components/ai/ModelWarmupModal'
import { OnDeviceLlmErrorToaster } from './components/ai/OnDeviceLlmErrorToaster'
import { RotationResumeModal } from './components/settings/RotationResumeModal'
import { RotationRecoveryRevealModal } from './components/settings/RotationRecoveryRevealModal'
import { SecureJournalWizard } from './components/settings/secureWizard/SecureJournalWizard'
import { useAuth } from './hooks/useAuth'
import { dropStatsCaches, invalidateStatsCache } from './hooks/useStats'
import { useForceRePair } from './hooks/useForceRePair'
import { useRotationResume } from './hooks/useRotationResume'
import { useLockAction } from './hooks/useLockAction'
import { useLanguageHydration } from './hooks/useLanguageHydration'
import { getEditorMathEnabled, hydrateEditorMathEnabled } from './hooks/useEditorMathEnabled'
import { hydrateEditorEmojiShortcodesEnabled } from './hooks/useEditorEmojiShortcodesEnabled'
import { hydrateEditorDistractionEnabled } from './hooks/useEditorDistractionEnabled'
import { hydrateLayoutPreset } from './hooks/useLayoutPreset'
import { hydrateDashboardCards } from './hooks/useDashboardCards'
import { hydrateEditorMediaStripCollapsed } from './hooks/useEditorMediaStripCollapsed'
import { hydrateEditorFixedTitleEnabled } from './hooks/useEditorFixedTitleEnabled'
import { hydrateMediaViewMode } from './hooks/useMediaViewMode'
import { hydrateEditorJustifyEnabled } from './hooks/useEditorJustifyEnabled'
import { hydrateEditorRightToLeftEnabled } from './hooks/useEditorRightToLeftEnabled'
import { hydrateEditorTypography } from './hooks/useEditorTypography'
import { ensureMathExtensions } from './lib/editorMath'
import { useDesignSystem } from './hooks/useDesignSystem'
import { useTitlebarRowHeightSync } from './hooks/useTitlebarRowHeightSync'
import { useTheme } from './hooks/useTheme'
import { reloadThemeSettings, useThemeInit } from './hooks/useThemeCustomization'
import { emitDbReady } from './lib/dbReady'
import { useReducedMotion } from './hooks/useReducedMotion'
import { useUiFontScale } from './hooks/useUiFontScale'
import { useGradientPrimary } from './hooks/useGradientPrimary'
import { useTabShortcuts } from './hooks/useTabShortcuts'
import { useTabNavigation } from './hooks/useTabNavigation'
import { useFlushTabSessionOnClose, useTabSessionHydrated } from './hooks/useTabSessionRestore'
import { useMenuEvents } from './hooks/useMenuEvents'
import { useReminderNotifications } from './hooks/useReminderNotifications'
import { useMediaCompressionEvents } from './hooks/useMediaCompressionEvents'
import { useAIProviderLifecycle } from './hooks/useAIProviderLifecycle'
import { useTitleStreamController } from './hooks/useTitleStreamController'
import { useInvisibleLock } from './hooks/useInvisibleLock'
import { useInvisibleLockAutoLock } from './hooks/useInvisibleLockAutoLock'
import { useSecondLock } from './hooks/useSecondLock'
import { useSecondLockAutoLock } from './hooks/useSecondLockAutoLock'
import { useUiStore } from './stores/uiStore'
import { applyLaunchView, useTabStore } from './stores/tabStore'
import { useSyncStore } from './stores/syncStore'
import { useOnboardingStore } from './stores/onboardingStore'
import { isEditorMounted } from './lib/editorMount'

/** Mount the last-tab quit confirm on every auth/shell branch. */
function withQuitConfirm(node: ReactNode) {
  return (
    <>
      <QuitConfirmDialog />
      <LiveAnnouncer />
      {node}
    </>
  )
}

function App() {
  // Design-system class must be on <html> before useThemeInit writes inline
  // accent tokens — applyAccent (Phase 2) reads ds-clean from the DOM.
  useDesignSystem() // stamps ds-* on <html>; applyAccent (Phase 2) reads this from the DOM
  useTitlebarRowHeightSync() // re-centres macOS traffic lights on the skin's titlebar row
  useTheme() // applies data-theme to document root; owns resolvedTheme logic
  useThemeInit() // applies accent color + font family from settings on boot
  useReducedMotion() // applies/removes 'reduce-motion' class on document root
  useUiFontScale() // applies --ui-font-scale on document root for interface text/icon size
  useGradientPrimary() // applies solid/gradient mode for --grad-primary
  useTitleStreamController() // owns the AI title-suggestion event stream
  useFlushTabSessionOnClose() // persist tabs on close/hide so relaunch restores them
  const hydrated = useTabSessionHydrated()
  useEffect(() => {
    if (hydrated) applyLaunchView()
  }, [hydrated])
  const {
    isLocked,
    encryptionMode,
    needsOnboarding,
    isBootFileCorrupt,
    clearBootFileCorrupt,
    hasReconciled,
    getPendingRotationRecovery,
  } = useAuth()
  // Computed here (rather than at its original spot below) because
  // `useForceRePair` re-hydrates the persisted flag once the real SQLCipher
  // connection is in place — the pre-unlock placeholder DB always reads the
  // flag as unset. See the hook's docs.
  // BootFileCorrupt keeps a placeholder connection until phrase recovery —
  // never treat it as dbReady (would hydrate against empty :memory:).
  const dbReady =
    hasReconciled && !isBootFileCorrupt && (encryptionMode !== 'password' || !isLocked)
  const {
    forceRePairRequired,
    reason: forceRePairReason,
    clearForceRePair,
  } = useForceRePair(dbReady)
  const { resumeRequired, isRevoke, clearResumeRequired } = useRotationResume()
  const { lock, lockBlockedReason } = useLockAction()

  // Re-reveal a rotation recovery phrase the user never confirmed saving (e.g.
  // the app closed/crashed after rotation completed but before they ticked
  // "I saved it"). The stash survives until confirmed, so we surface it again.
  // Stored in uiStore (not local useState) so the reveal modal is not bound to
  // the Settings subtree — it survives category switches and tab closes.
  const pendingRotationPhrase = useUiStore((s) => s.pendingRotationPhrase)
  const pendingRotationRevealIsReset = useUiStore((s) => s.pendingRotationRevealIsReset)
  const setPendingRotationPhrase = useUiStore((s) => s.setPendingRotationPhrase)

  // Live subscription (not useState/getState) — App does not remount across
  // the setup->wizard transition, so only a store subscription re-renders it
  // on both entry (setPending after setup completes) and exit (clearPending
  // when the wizard reaches `done`).
  const onboardingPending = useOnboardingStore((s) => s.pending)
  // One-shot welcome modal after the wizard finishes — armed by clearPending
  // and cleared by dismissCelebration so it never reappears.
  const celebrationPending = useOnboardingStore((s) => s.celebrationPending)
  const celebrationVariant = useOnboardingStore((s) => s.celebrationVariant)

  // The single trigger for hydrating DB-backed app state (theme, editor
  // prefs, ...) from the real SQLCipher connection. The connection is only the
  // real on-disk DB once one of:
  //   - Encryption is not password mode (`encryptionMode !== 'password'`)
  //   - The user has unlocked (`encryptionMode === 'password' && !isLocked`)
  // Before then the backend serves an empty `:memory:` placeholder, so any
  // `getSetting(...)` read returns null and persisted values look "reset to
  // defaults" — see `src/lib/dbReady.ts` for the full diagnosis.
  //
  // We deliberately do NOT also call these hydrations from inside their
  // respective hooks at mount time: doing so would race the real-DB read
  // against the placeholder, produce a brief flash of defaults on the lock
  // screen, and force every consumer through a redundant double-load.
  // (`dbReady` itself is computed above, before `useForceRePair`.)
  useInvisibleLock(dbReady)
  useInvisibleLockAutoLock()
  useSecondLock(dbReady)
  useSecondLockAutoLock()

  // Language is per-device state persisted to localStorage (never synced,
  // no SQLCipher dependency) — unlike the DB-backed hydrations below, it
  // must apply before unlock so the lock screen's language toggle works.
  useLanguageHydration()

  useEffect(() => {
    if (!dbReady) return
    void reloadThemeSettings()
    void hydrateEditorMathEnabled().then(() => {
      if (getEditorMathEnabled()) void ensureMathExtensions()
    })
    void hydrateEditorEmojiShortcodesEnabled()
    void hydrateEditorFixedTitleEnabled()
    void hydrateMediaViewMode()
    void hydrateEditorJustifyEnabled()
    void hydrateEditorRightToLeftEnabled()
    void hydrateEditorTypography()
    void hydrateEditorDistractionEnabled()
    void hydrateLayoutPreset()
    void hydrateDashboardCards()
    void hydrateEditorMediaStripCollapsed()
    // Sync status/settings were first read against the `:memory:` placeholder
    // (before unlock), so they look like "Sync off" / defaults. Re-fetch now
    // that the real SQLCipher DB is mounted. Without this the footer shows a
    // stale "Sync off" until the on-launch background sync event arrives
    // seconds later.
    void useSyncStore.getState().refresh()
    void useSyncStore.getState().refreshSettings()
    emitDbReady()
  }, [dbReady])

  // Once the real vault is unlocked, check for an unconfirmed rotation phrase
  // and re-reveal it. Gated on `dbReady` (same condition as the hydration
  // effect) so the getter never runs against the `:memory:` placeholder.
  useEffect(() => {
    if (!dbReady) return
    void getPendingRotationRecovery().then((phrase) => {
      if (phrase) setPendingRotationPhrase(phrase)
    })
  }, [dbReady, getPendingRotationRecovery])

  // Wire tab keyboard shortcuts (⌘T, ⌘W, ⌘1..9, ⌘⇧←/→)
  useTabShortcuts()
  const { goBack, goForward } = useTabNavigation()
  // Wire macOS menu bar events (e.g. Memlore > Settings)
  useMenuEvents()
  // Refresh media viewers after the background worker compresses a video.
  useMediaCompressionEvents()
  // Listen for reminder:fire events and send OS notifications.
  useReminderNotifications()
  // Phase 6 v2 R3: keep the in-memory `AIProvider` registry in sync with
  // the SQLCipher-encrypted settings table. Logs the active provider's
  // id + endpoint host + classification (NEVER the api_key or full
  // settings payload). No-op when no provider is configured.
  useAIProviderLifecycle()

  // Drop session-cached stats/emotion when entries mutate or the vault locks
  // so in-flight resolves cannot repopulate after invalidate (generation).
  useEffect(() => {
    const onEntriesChanged = () => invalidateStatsCache()
    window.addEventListener('memlore:entries-changed', onEntriesChanged)
    if (isLocked) dropStatsCaches()
    return () => window.removeEventListener('memlore:entries-changed', onEntriesChanged)
  }, [isLocked])

  // Global keyboard shortcuts (only when unlocked)
  useEffect(() => {
    if (isLocked) return

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        // EntryList owns `memlore:new-entry` and only mounts on entries-family
        // views — switch first, then dispatch on the next frame so the listener
        // is attached (same sequence as command palette `action.new_entry`).
        useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('memlore:new-entry'))
        })
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'k') {
        e.preventDefault()
        useUiStore.getState().setSearchOverlayOpen(true)
        return
      }
      // ⌘F — find in editor. Only swallow when an editor is mounted (Phase 4
      // wires the listener). On editor-less views, fall through so the
      // native browser Find still works.
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (!isEditorMounted()) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('memlore:editor-find'))
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        const active = document.activeElement
        const isEditor =
          active?.getAttribute('contenteditable') === 'true' ||
          active?.tagName === 'INPUT' ||
          active?.tagName === 'TEXTAREA'
        if (!isEditor) {
          e.preventDefault()
          useUiStore.getState().toggleSidebar()
        }
      }
      // ⌘⇧L — lock the app. Eligibility policy is centralized in
      // `useLockAction`: `lockBlockedReason !== null` covers both
      // "no password set" and "save in flight". Intentionally NO
      // `preventDefault` on the blocked path — leave the chord free
      // for future contextual bindings instead of swallowing it
      // silently.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        if (lockBlockedReason !== null) return
        e.preventDefault()
        void lock()
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        useUiStore.getState().toggleCommandPalette()
      }
    }
    // Mouse back/forward buttons (button 3 = back, button 4 = forward).
    // Use `mouseup` rather than `auxclick`: auxclick has spotty
    // cross-platform consistency in webviews, and we want to swallow
    // the event before the OS interprets it as a navigation gesture
    // anyway. `preventDefault` on mousedown is what blocks the default
    // browser back behaviour, so we also bind mousedown — without it
    // some webviews still trigger a history navigation regardless of
    // the mouseup handler.
    const mouseHandler = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        if (e.type === 'mouseup') goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        if (e.type === 'mouseup') goForward()
      }
    }
    // Some webviews also fire `auxclick` for buttons 3/4; suppress it
    // defensively so the OS navigation gesture stays dead even if
    // mousedown/mouseup wasn't enough.
    const auxClickSink = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('mousedown', mouseHandler)
    window.addEventListener('mouseup', mouseHandler)
    window.addEventListener('auxclick', auxClickSink)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('mousedown', mouseHandler)
      window.removeEventListener('mouseup', mouseHandler)
      window.removeEventListener('auxclick', auxClickSink)
    }
  }, [isLocked, lockBlockedReason, lock, goBack, goForward])

  // Keep the window movable while the first encryption probe completes.
  // Returning `null` here makes the Tauri window both blank and non-draggable
  // if backend startup is slow or blocked before auth reconciliation finishes.
  if (!hasReconciled) {
    return withQuitConfirm(<WindowDragRegion />)
  }

  // Boot sidecar invalid/unreadable — vault on disk is intact. Must render
  // BEFORE needsOnboarding so we never send the user into fresh-install
  // onboarding (which would look like data loss).
  if (isBootFileCorrupt) {
    return withQuitConfirm(
      <>
        <WindowDragRegion />
        <BootFileCorruptScreen onRecovered={clearBootFileCorrupt} />
      </>,
    )
  }

  // First launch: no vault exists yet. The journal is always encrypted, so
  // WelcomeScreen goes straight into the encrypted setup wizard — there is no
  // mode to pick. Mount <WindowDragRegion/> so the user can still move the
  // window — the full <TitleBar/> (which owns the regular drag region) isn't
  // on screen yet.
  if (needsOnboarding) {
    return withQuitConfirm(
      <>
        <WindowDragRegion />
        <WelcomeScreen />
      </>,
    )
  }

  // Vault was rotated from another device — this device's slot is stale.
  // User must re-pair before they can use the app.
  //
  // I2: WHY force-re-pair precedes LockScreen — neither branch is a bypass:
  //   - `vault_rotated`: the cloud vault was rotated by another device, so the
  //     local DB may still be keyed to the OLD master key and the old device
  //     password can no longer unwrap the new cloud keyring. The 24-word
  //     mnemonic is the ONLY path forward, and it — not the old password — is
  //     the security boundary.
  //   - Reconnect: nothing about the vault is proven yet, and the reconnect
  //     grants no data access on its own; `gdrive_complete_connect` verifies
  //     the current local password before it touches anything.
  if (forceRePairRequired) {
    // Route on the reason: only a real peer rotation (`vault_rotated`) needs the
    // 24-word phrase. A failed keyring CHECK — dead token, network blip, or a
    // cloud keyring that no longer exists — is fixed by reconnecting Drive, and
    // the phrase cannot help. Unknown/absent reasons take the reconnect screen
    // too: it is the lighter action, and it self-escalates to this screen if the
    // reconnect turns up a genuine rotation.
    return withQuitConfirm(
      <>
        <WindowDragRegion />
        {forceRePairReason === 'vault_rotated' ? (
          <ForceRePairScreen onCompleted={clearForceRePair} />
        ) : (
          <ReconnectDriveScreen onCompleted={clearForceRePair} />
        )}
      </>,
    )
  }

  // Password-locked: same story — LockScreen replaces the normal shell,
  // so we need an explicit drag strip at the top.
  if (encryptionMode === 'password' && isLocked) {
    return withQuitConfirm(
      <>
        <WindowDragRegion />
        <LockScreen />
      </>,
    )
  }

  // Post-setup onboarding wizard (pick theme, name first journal,
  // connect Drive, set up AI). Gated on `dbReady` because the DB must be
  // open before the wizard's steps can persist anything — placed after
  // LockScreen so a password user unlocks first.
  if (dbReady && onboardingPending) {
    return withQuitConfirm(
      <>
        <WindowDragRegion />
        <OnboardingWizard />
      </>,
    )
  }

  // Seed tab must not paint (or persist) before rehydrate lands.
  if (!hydrated) {
    return withQuitConfirm(<WindowDragRegion />)
  }

  return withQuitConfirm(
    <>
      <div className="xj-root">
        <TitleBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <TwoPanelLayout />
          </div>
          <FooterBar />
        </div>
      </div>
      <SearchOverlay />
      <CommandPalette />
      <EmbeddingExplainerPanel />
      {/* New device adopted a vault that already has AI slots: ask, then
          walk credentials with the cloud choices prefilled. Yields the
          embedding-decision modal until this one closes. */}
      <AdoptedAiSetupModal />
      {/* Multi-device embed sync decision (model mismatch / key blocks).
          Self-subscribes to ai:embedding-decision-needed; footer chip re-opens. */}
      <EmbeddingSyncDecisionModal />
      {/* On-device LLM cold-start UX (Phase 5 Task 3). Self-gates on the
          active generation provider + server lifecycle; renders null unless
          the llama-server is mid-startup past the 300ms flicker guard, or
          has failed to start. Auto-dismisses on `ready`; "Continue in
          background" lets the pending request keep running. */}
      <ModelWarmupModal />
      {/* Transient toast when the on-device sidecar fails to start (e.g. from
          Daily Chat, where the Settings status line isn't visible). */}
      <OnDeviceLlmErrorToaster />
      {/* C1: Rotation resume modal — shown when initialize_encryption detects a
          crash-interrupted rotation job on startup. Blocks interaction until
          the user provides their password + mnemonic to complete the rotation. */}
      <RotationResumeModal
        open={resumeRequired}
        isRevoke={isRevoke}
        onCompleted={async () => {
          clearResumeRequired()
          // D: After a ROTATE resume, the backend has finished and published a
          // new recovery phrase. Re-fetch it now so the reveal modal surfaces
          // immediately without waiting for the next relaunch.
          if (!isRevoke) {
            const phrase = await getPendingRotationRecovery()
            if (phrase) setPendingRotationPhrase(phrase)
          }
        }}
      />
      {/* Re-reveal an unconfirmed rotation recovery phrase (crash/close after
          rotation but before the user saved it). Non-dismissable until confirmed. */}
      <RotationRecoveryRevealModal
        key={pendingRotationPhrase ?? 'none'}
        open={pendingRotationPhrase !== null}
        phrase={pendingRotationPhrase ?? ''}
        isReset={pendingRotationRevealIsReset}
        onConfirmed={() => setPendingRotationPhrase(null)}
      />
      {/* "Secure my journal" triage wizard — mounted at App level (not inside
          Settings) because the cut-off chain spans an OAuth browser round-trip
          that unmounts Settings, and the wizard must survive it. Opens from
          both Settings → Security actions and Sync → Devices revoke. */}
      <SecureJournalWizard />
      {/* One-shot welcome after post-setup onboarding (armed when the wizard
          reaches `done` via clearPending — setup or setup-sync when Drive
          was linked) or after this device joined an existing cloud vault
          (armJoinCelebration → joined-sync). Dismissing clears the flag
          permanently for this device. */}
      <OnboardingCelebrationModal
        open={celebrationPending}
        variant={celebrationVariant}
        onClose={() => useOnboardingStore.getState().dismissCelebration()}
      />
      {/* Surfaces the result of a Google Drive connect the user started during
          onboarding but let finish in the background (see DriveStep). */}
      <GdriveConnectToaster />
    </>,
  )
}

export default App
