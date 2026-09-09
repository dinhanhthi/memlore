import { describe, expect, it } from 'vitest'
import {
  createInitialSecureWizardState,
  nextStep,
  prevStep,
  stepCounter,
  type SecureWizardChoice,
  type SecureWizardState,
  type SecureWizardStep,
} from './secureWizardGraph'

function advance(
  choices: SecureWizardChoice[],
  initial: SecureWizardState = createInitialSecureWizardState(),
): SecureWizardState {
  return choices.reduce(nextStep, initial)
}

function at(step: SecureWizardStep, overrides: Partial<SecureWizardState> = {}): SecureWizardState {
  return { ...createInitialSecureWizardState(), step, ...overrides }
}

describe('secure wizard graph', () => {
  it.each([
    {
      branch: 'recovery words leaked',
      choices: ['words_leaked', 'next', 'next', 'next'] satisfies SecureWizardChoice[],
      terminal: 'reset_done',
    },
    {
      branch: 'password leaked',
      choices: ['password_leaked', 'device_not_reached'] satisfies SecureWizardChoice[],
      terminal: 'password_change',
    },
    {
      branch: 'device compromised',
      choices: [
        'device_compromised',
        'next',
        'phrase_safe',
        'revoke_only',
        'next',
        'next',
      ] satisfies SecureWizardChoice[],
      terminal: 'revoke_done',
    },
    {
      branch: 'routine rotation',
      choices: ['routine_rotation', 'next', 'next', 'next'] satisfies SecureWizardChoice[],
      terminal: 'routine_done',
    },
  ])('routes the $branch triage branch to its terminal node', ({ choices, terminal }) => {
    expect(advance(choices).step).toBe(terminal)
  })

  it('skips the device picker when the wizard was seeded for a device', () => {
    const seeded = at('triage', {
      seeded: true,
      targetDevice: { id: 'device-2', name: 'Travel laptop' },
    })

    expect(nextStep(seeded, 'device_compromised').step).toBe('device_words')
  })

  it.each([
    ['cutoff_1', { current: 1, total: 3 }],
    ['cutoff_2', { current: 2, total: 3 }],
    ['cutoff_3', { current: 3, total: 3 }],
  ] satisfies [SecureWizardStep, { current: number; total: number }][])(
    'counts %s inside the full cut-off chain',
    (step, expected) => {
      expect(stepCounter(at(step))).toEqual(expected)
    },
  )

  it.each(['triage', 'device_scope', 'cutoff_done'] satisfies SecureWizardStep[])(
    'does not show a counter outside the active cut-off chain at %s',
    (step) => {
      expect(stepCounter(at(step))).toBeNull()
    },
  )

  it('enters cutoff step 2 directly after an already completed revoke', () => {
    const result = nextStep(at('revoke_done'), 'cutoff_google')

    expect(result).toMatchObject({ step: 'cutoff_2', cutoffEnteredLate: true })
  })

  it('returns from late cutoff step 2 to the completed revoke screen', () => {
    const lateEntry = at('cutoff_2', { cutoffEnteredLate: true })

    expect(prevStep(lateEntry).step).toBe('revoke_done')
  })

  it.each([
    ['cutoff_2', { current: 1, total: 2 }],
    ['cutoff_3', { current: 2, total: 2 }],
  ] satisfies [SecureWizardStep, { current: number; total: number }][])(
    'counts late-entry %s inside its two-step chain',
    (step, expected) => {
      expect(stepCounter(at(step, { cutoffEnteredLate: true }))).toEqual(expected)
    },
  )

  it.each(['revoke_done', 'cutoff_done'] satisfies SecureWizardStep[])(
    'routes %s to recovery-word reset when the phrase may have leaked',
    (step) => {
      expect(nextStep(at(step, { needsPhraseReset: true }), 'next').step).toBe('words_leaked')
    },
  )

  it.each([
    ['reset_done', 'reset_running'],
    ['revoke_done', 'revoke_running'],
    ['routine_done', 'routine_running'],
    ['cutoff_2', 'cutoff_1'],
  ] satisfies [SecureWizardStep, SecureWizardStep][])(
    'does not go back from %s to completed mutation node %s',
    (step, mutationStep) => {
      expect(prevStep(at(step)).step).not.toBe(mutationStep)
    },
  )

  it('routes the just-remove branch from device_words to its terminal node', () => {
    const state = advance(['just_remove', 'next', 'next'], at('device_words'))

    expect(state.step).toBe('remove_done')
  })

  it('goes back from remove_confirm to device_words', () => {
    expect(prevStep(at('remove_confirm')).step).toBe('device_words')
  })

  it('treats remove_done as terminal — no back into remove_running', () => {
    expect(prevStep(at('remove_done')).step).toBe('remove_done')
  })

  it('clears a stale phrase-leak answer when the user chooses just_remove', () => {
    const result = nextStep(at('device_words', { needsPhraseReset: true }), 'just_remove')

    expect(result).toMatchObject({ step: 'remove_confirm', needsPhraseReset: false })
  })

  it('records whether the recovery phrase may have leaked', () => {
    const result = nextStep(at('device_words'), 'phrase_leaked')

    expect(result).toMatchObject({ step: 'device_scope', needsPhraseReset: true })
  })

  it('does not mutate the input state', () => {
    const state = at('device_words')

    nextStep(state, 'phrase_leaked')

    expect(state).toEqual(at('device_words'))
  })
})
