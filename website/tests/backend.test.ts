import { beforeEach, expect, it } from 'vitest'
import { demoInvoke, resetDemo } from '../demo/backend'
import type { Entry } from '../../src/types/entry'
import { entries } from '../../web/fixtures/entries'
beforeEach(resetDemo)
it('persists unique entry content, favorites and deletion', async () => {
  const first = (await demoInvoke('create_entry', { title: 'My memory' })) as Entry
  const second = (await demoInvoke('create_entry')) as Entry
  expect(first.id).not.toBe(second.id)
  await demoInvoke('save_entry_content', {
    id: first.id,
    yjsDoc: [1, 2],
    contentText: 'A new memory',
    previewText: 'A new memory',
  })
  expect(await demoInvoke('get_entry_content', { id: first.id })).toEqual([1, 2])
  expect(await demoInvoke('toggle_favorite', { id: first.id })).toBe(true)
  expect(await demoInvoke('search_entries', { query: 'A new memory' })).toEqual([
    expect.objectContaining({ id: first.id }),
  ])
  await demoInvoke('soft_delete_entry', { id: first.id })
  expect(await demoInvoke('get_entry', { id: first.id })).toBeNull()
})
it('reveals seeded invisible entries only with demo vault', async () => {
  const entry = entries.find((item) => item.is_invisible)!
  expect(entry).toBeDefined()
  expect(await demoInvoke('get_entry', { id: entry.id })).toBeNull()
  const activeVaultId = await demoInvoke('open_or_create_invisible_vault', { password: 'memlore' })
  expect(await demoInvoke('get_entry', { id: entry.id, activeVaultId })).toHaveProperty(
    'id',
    entry.id,
  )
  expect(await demoInvoke('verify_second_lock_password', { password: 'wrong' })).toBe(false)
  expect(await demoInvoke('verify_second_lock_password', { password: 'memlore' })).toBe(true)
})
it('creates, renames, reopens and deletes sessions', async () => {
  const sessionId = await demoInvoke('daily_chat_create_session')
  await demoInvoke('daily_chat_rename_session', { sessionId, title: 'Reflection' })
  expect(await demoInvoke('daily_chat_load_session', { sessionId })).toHaveProperty(
    'title',
    'Reflection',
  )
  await demoInvoke('daily_chat_delete_session', { sessionId })
  await expect(demoInvoke('daily_chat_load_session', { sessionId })).rejects.toThrow()
})
