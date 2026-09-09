import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Tracks whether the post-setup onboarding wizard (pick theme, name first
 * journal, connect Drive, set up AI) is pending for this device.
 *
 * Why localStorage and not a DB setting:
 * - Per-device first-run state, not app data — it describes what this
 *   installation has and hasn't shown the user yet, not something about
 *   the vault's content.
 * - Must never sync. If it lived in the encrypted DB (or any synced
 *   surface), a second device restoring a vault from the cloud would
 *   inherit `pending: true` and get shown the wizard again, even though
 *   the vault already has real journals/entries. `pending: false` (the
 *   default) means "this device never entered the fresh-vault setup
 *   flow" — correct for legacy installs and for cloud-adopt devices.
 * - Must be readable before the encrypted DB is open. The wizard gate
 *   sits right after first-time setup (password or skip), before the DB
 *   is unlocked/loaded, so the flag can't depend on DB access.
 *
 * `celebrationPending` is the one-shot "welcome to the main app" modal
 * shown immediately after the wizard reaches `done`. It is set by
 * `clearPending()` (only called from that transition) and cleared by
 * `dismissCelebration()` so it never reappears after the user closes it.
 *
 * `celebrationVariant` picks which copy that modal shows:
 * - `setup` — fresh vault, no Drive (generic welcome).
 * - `setup-sync` — fresh vault, Drive connected during the wizard; body
 *   points at the footer sync status while the first upload runs.
 * - `joined-sync` — this device joined an EXISTING cloud vault (no wizard);
 *   body points at the footer while the first download runs.
 *
 * Join arms via `armJoinCelebration()` (must live in this persisted store
 * rather than component state because arming is immediately followed by the
 * `encryption_mode` flip that re-routes and unmounts the whole app). Wizard
 * finish arms via `clearPending(variant)`.
 */
export type CelebrationVariant = 'setup' | 'setup-sync' | 'joined-sync'

/** The variants the WIZARD may arm. `joined-sync` is excluded by type: a
 *  device that ran the wizard created a fresh vault, so it can never be the
 *  device that joined an existing one. Before `clearPending` took a variant
 *  at all this was guaranteed structurally (it hardcoded `'setup'`) — keeping
 *  the narrow type keeps that a compile error rather than a convention. */
export type WizardCelebrationVariant = Exclude<CelebrationVariant, 'joined-sync'>

const WIZARD_CELEBRATION_VARIANTS: readonly WizardCelebrationVariant[] = ['setup', 'setup-sync']

const VALID_CELEBRATION_VARIANTS: readonly CelebrationVariant[] = [
  ...WIZARD_CELEBRATION_VARIANTS,
  'joined-sync',
]

export function isCelebrationVariant(value: unknown): value is CelebrationVariant {
  return (
    typeof value === 'string' && (VALID_CELEBRATION_VARIANTS as readonly string[]).includes(value)
  )
}

function isWizardCelebrationVariant(value: unknown): value is WizardCelebrationVariant {
  return (
    typeof value === 'string' && (WIZARD_CELEBRATION_VARIANTS as readonly string[]).includes(value)
  )
}

interface OnboardingState {
  pending: boolean
  /** True until the post-onboarding celebration modal is dismissed. */
  celebrationPending: boolean
  celebrationVariant: CelebrationVariant
  setPending: () => void
  /**
   * Leave the wizard and arm the one-shot celebration modal.
   * Pass `setup-sync` when Drive was connected during the wizard so the
   * user is told the first sync is running in the footer.
   */
  clearPending: (variant?: WizardCelebrationVariant) => void
  armJoinCelebration: () => void
  dismissCelebration: () => void
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      pending: false,
      celebrationPending: false,
      celebrationVariant: 'setup',

      setPending: () => set({ pending: true }),

      // Finishing the wizard: leave the setup flow and arm the one-shot
      // welcome modal over the main shell. Default is the generic welcome;
      // the wizard passes `setup-sync` when Drive is already connected.
      clearPending: (variant = 'setup') =>
        set({
          pending: false,
          celebrationPending: true,
          celebrationVariant: isWizardCelebrationVariant(variant) ? variant : 'setup',
        }),

      // Joining an existing cloud vault: no wizard runs, so arm the same
      // one-shot modal directly with the "first sync is running" copy.
      armJoinCelebration: () =>
        set({ celebrationPending: true, celebrationVariant: 'joined-sync' }),

      dismissCelebration: () => set({ celebrationPending: false }),
    }),
    {
      name: 'memlore-onboarding',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pending: state.pending,
        celebrationPending: state.celebrationPending,
        celebrationVariant: state.celebrationVariant,
      }),
      // After rehydrate, coerce a corrupt/non-boolean stored value to the
      // default. Without this, a hand-edited or malformed localStorage
      // entry could leave `pending` as a non-boolean, which downstream
      // gating logic (`if (pending) ...`) would still coerce truthy for
      // any non-empty string — silently showing the wizard forever.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (typeof state.pending !== 'boolean') {
          state.pending = false
        }
        if (typeof state.celebrationPending !== 'boolean') {
          state.celebrationPending = false
        }
        if (!isCelebrationVariant(state.celebrationVariant)) {
          state.celebrationVariant = 'setup'
        }
      },
    },
  ),
)
