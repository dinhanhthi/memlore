export type ScenarioPreview =
  | {
      kind: 'onboard-new-device'
      initialStep?: 'passphrase' | 'unlock_method' | 'password'
    }
  | {
      // The post-setup onboarding wizard (theme → name journal → Drive → AI),
      // rendered on its own so the steps' UI can be checked without walking
      // through the whole first-run flow.
      kind: 'onboarding-wizard'
    }
  | {
      // AIStep rendered standalone (no wizard chrome) so each of its sub-stages
      // (enable → provider → gen_config → embedding → features) can be opened
      // directly via the ScenarioPicker's step selector.
      kind: 'ai-step'
    }
  | {
      // WelcomeScreen rendered standalone so each of its in-place screens
      // (language / intro / cloud-empty-prompt) can be opened directly via the
      // ScenarioPicker's step selector.
      kind: 'welcome'
    }

/**
 * Sub-step selector shown in the ScenarioPicker for multi-step preview screens
 * (AIStep sub-stages, WelcomeScreen screens). The selected option
 * `id` is routed into the preview as its initial step. The first option is the
 * default opened when the scenario is applied.
 */
export interface ScenarioSteps {
  /** Short label shown before the step buttons (e.g. "Stage", "Screen"). */
  label: string
  options: { id: string; label: string }[]
}

export interface Scenario {
  id: string
  label: string
  group: 'auth' | 'app' | 'sync' | 'settings'
  /**
   * Primary screen component file name (with `.tsx`) shown as a bottom-left
   * badge in the web harness so you can jump to the right source file quickly.
   */
  componentFile: string
  /**
   * When `componentFile` hosts multiple screen sections (tabs, wizard steps,
   * inline panels), the function/component name for the section this scenario
   * opens. Shown after the file name in the badge (e.g. `EncryptionSettings.tsx › SecondLockSettings`).
   */
  componentName?: string
  invoke?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>
  emitOnLoad?:
    | Array<{ event: string; payload: unknown; delayMs?: number }>
    | (() => Array<{ event: string; payload: unknown; delayMs?: number }>)
  seedStores?: () => void
  /**
   * Web-harness-only hook run after scenario apply (and after remount is
   * scheduled). Use for visual states that require a post-mount DOM action
   * (e.g. expanding the Sync help disclosure). Never used by the Tauri app.
   */
  afterMount?: () => void
  /** Render a web-only preview root instead of App.tsx (same src components). */
  preview?: ScenarioPreview
  /** Sub-step selector shown in the ScenarioPicker (see `ScenarioSteps`). The
   *  selected id is routed into the `preview` as its initial step. */
  steps?: ScenarioSteps
}
