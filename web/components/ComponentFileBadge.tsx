import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useForceRePairStore } from '../../src/hooks/useForceRePair'
import { useOnboardingStore } from '../../src/stores/onboardingStore'
import { useSettingsStore } from '../../src/stores/settingsStore'
import { useTabStore } from '../../src/stores/tabStore'
import { type SecurityTab } from '../../src/stores/uiStore'
import type { Scenario } from '../scenarios/types'

interface ComponentFileBadgeProps {
  scenario: Scenario
}

const ONBOARDING_STEP_COMPONENTS = ['ThemeStep', 'JournalStep', 'DriveStep', 'AIStep'] as const

/** EN: "Step 1 of 4" · VI: "Bước 1 / 4" (and optional " - Set up AI" suffix). */
const ONBOARDING_STEP_RE = /(?:Step\s+(\d+)\s+of\s+4|Bước\s+(\d+)\s*\/\s*4)/

/** Map Security tabs → panel/function name inside EncryptionSettings.tsx. */
function securitySectionName(tab: SecurityTab, encryptionMode: string | null): string {
  switch (tab) {
    case 'device_password':
      return 'renderDevicePasswordPanel'
    case 'second_lock':
      return encryptionMode === 'password' ? 'SecondLockSettings' : 'renderProtectedContentPanel'
    case 'invisible_lock':
      return 'InvisibleLockSettings'
    case 'recovery_devices':
      return 'renderRecoveryPanel'
    default:
      return tab
  }
}

/** Live wizard step for OnboardingWizard (step state is not in a global store). */
function useOnboardingWizardStepName(enabled: boolean): string | undefined {
  const [name, setName] = useState<string | undefined>(ONBOARDING_STEP_COMPONENTS[0])

  useEffect(() => {
    if (!enabled) return

    const scan = () => {
      const match = document.body.innerText.match(ONBOARDING_STEP_RE)
      if (!match) return
      const n = Number(match[1] ?? match[2])
      if (n >= 1 && n <= ONBOARDING_STEP_COMPONENTS.length) {
        setName(ONBOARDING_STEP_COMPONENTS[n - 1])
      }
    }

    const timeoutId = window.setTimeout(scan, 0)
    const id = window.setInterval(scan, 400)
    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(id)
    }
  }, [enabled])

  return enabled ? name : undefined
}

interface ResolvedBadge {
  fileName: string
  componentName?: string
}

/**
 * Resolve the *currently rendered* screen — not just the scenario's static
 * `componentFile`. App can transition Welcome → OnboardingWizard (or lock /
 * force-re-pair) without changing the active scenario id.
 *
 * Priority mirrors `App.tsx` gates + web preview roots.
 */
function useResolvedBadge(scenario: Scenario): ResolvedBadge {
  const encryptionMode = useSettingsStore((s) => s.encryptionMode)
  const isLocked = useSettingsStore((s) => s.isLocked)
  const onboardingPending = useOnboardingStore((s) => s.pending)
  const forceRePairRequired = useForceRePairStore((s) => s.forceRePairRequired)
  const forceRePairReason = useForceRePairStore((s) => s.reason)
  const settingsCategory = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.settingsCategory ?? 'security'
  })
  const securityTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.securityTab ?? 'device_password'
  })

  const preview = scenario.preview
  const showingWizardPreview = preview?.kind === 'onboarding-wizard'
  // Full-screen wizard either via web preview root or App post-setup gate.
  // `encryptionMode === 'unset'` is still WelcomeScreen (checked first
  // below), so we only treat pending as wizard when mode is already chosen.
  const showingWizardInApp =
    !preview &&
    onboardingPending &&
    encryptionMode !== null &&
    encryptionMode !== 'unset' &&
    !(encryptionMode === 'password' && isLocked) &&
    !forceRePairRequired
  const showingWizard = showingWizardPreview || showingWizardInApp

  const wizardStep = useOnboardingWizardStepName(showingWizard)

  // 1. Web-only preview roots (bypass App.tsx)
  if (preview?.kind === 'onboard-new-device') {
    return {
      fileName: 'OnboardNewDeviceScreen.tsx',
      componentName: preview.initialStep ?? scenario.componentName ?? 'passphrase',
    }
  }
  if (showingWizardPreview || showingWizardInApp) {
    return {
      fileName: 'OnboardingWizard.tsx',
      componentName: wizardStep ?? scenario.componentName ?? 'ThemeStep',
    }
  }

  // 2. App.tsx full-screen auth gates (same order as App)
  if (encryptionMode === 'unset') {
    return { fileName: 'WelcomeScreen.tsx' }
  }
  if (forceRePairRequired) {
    return {
      fileName:
        forceRePairReason === 'vault_rotated'
          ? 'ForceRePairScreen.tsx'
          : 'ReconnectDriveScreen.tsx',
    }
  }
  if (encryptionMode === 'password' && isLocked) {
    return { fileName: 'LockScreen.tsx' }
  }

  // 3. App shell — keep scenario mapping, with live section for multi-panel files
  const fileName = scenario.componentFile
  let componentName = scenario.componentName

  if (fileName === 'EncryptionSettings.tsx' && settingsCategory === 'security') {
    componentName = securitySectionName(securityTab, encryptionMode)
  }

  return { fileName, componentName }
}

/** Fixed bottom-right badge showing the currently rendered TSX file (+ section). */
export function ComponentFileBadge({ scenario }: ComponentFileBadgeProps) {
  const { fileName, componentName } = useResolvedBadge(scenario)

  return createPortal(
    <div
      data-testid="scenario-component-file"
      // Offset left of the docked ScenarioPicker sidebar so the badge is never
      // hidden underneath it (the var is 0px in floating mode).
      style={{ right: 'calc(0.75rem + var(--xj-web-dock-width, 0px))' }}
      className="scenario-component-file-badge fixed bottom-3 z-9999 rounded border border-white/10 bg-zinc-900/90 px-2 py-1 font-mono text-[11px] text-zinc-400 shadow-lg select-text"
    >
      <span>{fileName}</span>
      {componentName ? (
        <>
          <span className="mx-1 text-zinc-600">›</span>
          <span className="text-zinc-300">{componentName}</span>
        </>
      ) : null}
    </div>,
    document.body,
  )
}
