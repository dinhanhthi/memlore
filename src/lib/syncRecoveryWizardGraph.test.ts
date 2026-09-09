import { describe, expect, it } from 'vitest'
import {
  createInitialSyncRecoveryWizardState,
  nextStep,
  prevStep,
  type SyncRecoveryWizardChoice,
  type SyncRecoveryWizardState,
  type SyncRecoveryWizardStep,
} from './syncRecoveryWizardGraph'

function at(step: SyncRecoveryWizardStep): SyncRecoveryWizardState {
  return { step }
}

describe('syncRecoveryWizardGraph', () => {
  describe('createInitialSyncRecoveryWizardState', () => {
    it('starts at triage', () => {
      expect(createInitialSyncRecoveryWizardState()).toEqual({ step: 'triage' })
    })
  })

  describe('nextStep', () => {
    it.each([
      ['triage', 'sync_stuck', 'reset_confirm'],
      ['triage', 'device_wrong', 'cloud_to_local_confirm'],
      ['triage', 'cloud_wrong', 'local_to_cloud_confirm'],
      ['triage', 'stop_syncing', 'stop_choice'],
      ['reset_confirm', 'next', 'reset_running'],
      ['reset_running', 'next', 'reset_done'],
      ['stop_choice', 'keep_cloud', 'disconnect_confirm'],
      ['stop_choice', 'delete_cloud', 'delete_confirm'],
      ['disconnect_confirm', 'next', 'disconnect_running'],
      ['disconnect_running', 'next', 'disconnect_done'],
      ['delete_confirm', 'next', 'delete_running'],
      ['delete_running', 'next', 'delete_done'],
    ] satisfies [SyncRecoveryWizardStep, SyncRecoveryWizardChoice, SyncRecoveryWizardStep][])(
      'moves from %s via %s to %s',
      (step, choice, expected) => {
        expect(nextStep(at(step), choice).step).toBe(expected)
      },
    )

    it.each([
      'reset_confirm',
      'reset_running',
      'reset_done',
      'cloud_to_local_confirm',
      'local_to_cloud_confirm',
      'stop_choice',
      'disconnect_confirm',
      'disconnect_running',
      'disconnect_done',
      'delete_confirm',
      'delete_running',
      'delete_done',
    ] satisfies SyncRecoveryWizardStep[])(
      'returns the same state reference for an unhandled choice at %s',
      (step) => {
        const state = at(step)
        expect(nextStep(state, 'sync_stuck')).toBe(state)
      },
    )

    it.each(['reset_done', 'disconnect_done', 'delete_done'] satisfies SyncRecoveryWizardStep[])(
      'treats %s as terminal — next is a no-op',
      (step) => {
        const state = at(step)
        expect(nextStep(state, 'next')).toBe(state)
      },
    )

    it.each([
      'cloud_to_local_confirm',
      'local_to_cloud_confirm',
    ] satisfies SyncRecoveryWizardStep[])('has no next transition from %s', (step) => {
      const state = at(step)
      expect(nextStep(state, 'next')).toBe(state)
    })

    it('returns the same state reference for an unknown triage choice', () => {
      const state = at('triage')
      expect(nextStep(state, 'keep_cloud')).toBe(state)
    })

    it('ignores a "next" choice at stop_choice (only keep_cloud/delete_cloud are valid there)', () => {
      const state = at('stop_choice')
      expect(nextStep(state, 'next')).toBe(state)
    })

    it('does not mutate the input state', () => {
      const state = at('triage')
      nextStep(state, 'sync_stuck')
      expect(state).toEqual({ step: 'triage' })
    })
  })

  describe('prevStep', () => {
    it.each([
      ['reset_confirm', 'triage'],
      ['cloud_to_local_confirm', 'triage'],
      ['local_to_cloud_confirm', 'triage'],
      ['stop_choice', 'triage'],
      ['disconnect_confirm', 'stop_choice'],
      ['delete_confirm', 'stop_choice'],
      ['reset_running', 'reset_confirm'],
      ['disconnect_running', 'disconnect_confirm'],
      ['delete_running', 'delete_confirm'],
    ] satisfies [SyncRecoveryWizardStep, SyncRecoveryWizardStep][])(
      'goes back from %s to %s',
      (step, expected) => {
        expect(prevStep(at(step)).step).toBe(expected)
      },
    )

    it.each([
      'triage',
      'reset_done',
      'disconnect_done',
      'delete_done',
    ] satisfies SyncRecoveryWizardStep[])('treats %s as terminal for back navigation', (step) => {
      const state = at(step)
      expect(prevStep(state)).toBe(state)
    })
  })

  describe('exhaustive SyncRecoveryWizardStep union', () => {
    it('typechecks a Record walk of every step through nextStep and prevStep', () => {
      // Missing a new SyncRecoveryWizardStep here fails typecheck. Production
      // nextStep/prevStep also have default `never` arms for the same gate.
      const allSteps: Record<SyncRecoveryWizardStep, true> = {
        triage: true,
        reset_confirm: true,
        reset_running: true,
        reset_done: true,
        cloud_to_local_confirm: true,
        local_to_cloud_confirm: true,
        stop_choice: true,
        disconnect_confirm: true,
        disconnect_running: true,
        disconnect_done: true,
        delete_confirm: true,
        delete_running: true,
        delete_done: true,
      }

      for (const step of Object.keys(allSteps) as SyncRecoveryWizardStep[]) {
        const state = at(step)
        expect(nextStep(state, 'next').step).toBeTypeOf('string')
        expect(prevStep(state).step).toBeTypeOf('string')
      }
    })
  })
})
