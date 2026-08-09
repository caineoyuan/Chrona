import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearPendingInviteToken,
  pendingInviteToken,
  retainInviteToken,
} from '../src/invitations.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

test('invite token survives login and registration navigation in session storage', () => {
  const storage = memoryStorage()
  const token = 'C'.repeat(43)

  assert.equal(retainInviteToken({ search: `?invite=${token}` }, storage), token)
  assert.equal(retainInviteToken({ search: '?register=1' }, storage), token)
  assert.equal(pendingInviteToken(storage), token)

  clearPendingInviteToken(storage)
  assert.equal(pendingInviteToken(storage), null)
})

test('invalid invite tokens are not retained', () => {
  const storage = memoryStorage()
  assert.equal(retainInviteToken({ search: '?invite=short' }, storage), null)
})

test('retained tokens are removed from the address bar', () => {
  const storage = memoryStorage()
  const token = 'D'.repeat(43)
  let replacement
  retainInviteToken(
    {
      href: `https://chrona.example/?invite=${token}&workspace=medira#today`,
      search: `?invite=${token}&workspace=medira`,
    },
    storage,
    {
      state: { view: 'login' },
      replaceState: (state, _title, url) => {
        replacement = { state, url: String(url) }
      },
    },
  )

  assert.deepEqual(replacement.state, { view: 'login' })
  assert.equal(replacement.url, 'https://chrona.example/?workspace=medira#today')
})
