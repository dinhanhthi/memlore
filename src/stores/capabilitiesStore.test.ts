import { beforeEach, describe, expect, it } from 'vitest'
import { useCapabilitiesStore } from './capabilitiesStore'

describe('capabilitiesStore', () => {
  beforeEach(() => {
    useCapabilitiesStore.setState({ writes: true, outboxV2: false, monthIndex: false })
  })

  it('defaults to desktop value (writes allowed)', () => {
    expect(useCapabilitiesStore.getState().writes).toBe(true)
  })

  it('setWrites updates the flag', () => {
    useCapabilitiesStore.getState().setWrites(false)
    expect(useCapabilitiesStore.getState().writes).toBe(false)
  })

  it('runtime web capabilities default to false (fail closed)', () => {
    const s = useCapabilitiesStore.getInitialState()
    expect(s.outboxV2).toBe(false)
    expect(s.monthIndex).toBe(false)
  })

  it('setWebCapabilities applies the event payload', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: true, monthIndex: true })
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: false, monthIndex: true })
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: false, monthIndex: true })
  })

  it('setWebCapabilities coerces a malformed payload to false', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: 'yes', monthIndex: 1 })
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: false, monthIndex: false })
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    useCapabilitiesStore.getState().setWebCapabilities(null)
    expect(useCapabilitiesStore.getState()).toMatchObject({ outboxV2: false, monthIndex: false })
  })

  it('setWebCapabilities never touches writes', () => {
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: true, monthIndex: true })
    expect(useCapabilitiesStore.getState().writes).toBe(true)
  })
})
