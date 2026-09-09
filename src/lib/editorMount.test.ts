import { describe, it, expect } from 'vitest'
import { registerActiveEditorInstance, isActiveEditorInstance } from './editorMount'

describe('registerActiveEditorInstance / isActiveEditorInstance', () => {
  it('the most recently registered instance is active', () => {
    const first = registerActiveEditorInstance()
    const second = registerActiveEditorInstance()

    expect(isActiveEditorInstance(second)).toBe(true)
    expect(isActiveEditorInstance(first)).toBe(false)
  })

  it('re-registering the same logical panel makes it active again', () => {
    const a = registerActiveEditorInstance()
    registerActiveEditorInstance() // some other panel mounts
    expect(isActiveEditorInstance(a)).toBe(false)

    const aAgain = registerActiveEditorInstance() // "a" remounts (e.g. tab switch back)
    expect(isActiveEditorInstance(aAgain)).toBe(true)
  })

  it('an id from before any registration is never active', () => {
    expect(isActiveEditorInstance(0)).toBe(false)
  })
})
