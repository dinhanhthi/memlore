import { beforeEach, describe, expect, it } from 'vitest'
import { useCapabilitiesStore } from './capabilitiesStore'

describe('capabilitiesStore', () => {
  beforeEach(() => {
    useCapabilitiesStore.setState({ writes: true })
  })

  it('defaults to desktop value (writes allowed)', () => {
    expect(useCapabilitiesStore.getState().writes).toBe(true)
  })

  it('setWrites updates the flag', () => {
    useCapabilitiesStore.getState().setWrites(false)
    expect(useCapabilitiesStore.getState().writes).toBe(false)
  })
})
