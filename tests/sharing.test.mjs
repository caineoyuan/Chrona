import assert from 'node:assert/strict'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import {
  createSharingRouter,
  hashInviteToken,
} from '../server/sharing.js'
import { validatePermissions } from '../server/sharing-auth.js'

process.env.JWT_SECRET = 'sharing-test-secret'

function authCookie(userId = 7) {
  return `chrona_token=${jwt.sign({ uid: userId }, process.env.JWT_SECRET)}`
}

async function request(pool, path, options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/sharing', createSharingRouter(pool))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    return await fetch(`http://127.0.0.1:${address.port}/api/sharing${path}`, {
      ...options,
      headers: { Cookie: authCookie(), ...options.headers },
    })
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
}

function fakePool(handler) {
  const calls = []
  const client = {
    async query(text, params) {
      calls.push({ text, params })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
      return handler(text, params, calls)
    },
    release() {
      calls.push({ text: 'RELEASE' })
    },
  }
  return {
    calls,
    connect: async () => client,
    query: client.query,
  }
}

test('permission payloads are strict for both resource types', () => {
  assert.deepEqual(validatePermissions('buddy_streak', { role: 'observer' }), {
    role: 'observer',
  })
  assert.equal(
    validatePermissions('medication', { role: 'editor', canViewHistory: true }),
    null,
  )
  assert.deepEqual(
    validatePermissions('medication_list', { role: 'viewer', canViewHistory: false }),
    { role: 'viewer', can_view_history: false },
  )
  assert.equal(validatePermissions('buddy_streak', { role: 'owner' }), null)
  assert.equal(
    validatePermissions('medication', {
      role: 'viewer',
      canViewHistory: false,
      medicationId: 99,
    }),
    null,
  )
})

test('link invitation returns a raw token but stores only its SHA-256 hash', async () => {
  let insertedParams
  const pool = fakePool(async (text, params) => {
    if (text.includes('FROM medication_lists')) return { rows: [{ owner_user_id: '7' }] }
    if (text.includes('INSERT INTO share_invites')) {
      insertedParams = params
      return { rows: [{ id: '8', expires_at: '2030-01-01T00:00:00.000Z' }] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/invitations/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceType: 'medication_list',
      resourceId: '7',
      permissions: { role: 'viewer', canViewHistory: false },
      expiresInHours: 24,
      maxUses: 3,
    }),
  })
  const body = await response.json()

  assert.equal(response.status, 201)
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(body.invitePath, `/?invite=${body.token}`)
  assert.equal(insertedParams[5], hashInviteToken(body.token))
  assert.notEqual(insertedParams[5], body.token)
  assert.equal(insertedParams[7], 3)
})

test('exact-username invitations use the same generic response for absent and self users', async () => {
  for (const targetRows of [[], [{ id: 7 }]]) {
    const pool = fakePool(async (text) => {
      if (text.includes('FROM buddy_streaks')) return { rows: [{ id: '12' }] }
      if (text.includes('FROM users')) return { rows: targetRows }
      assert.doesNotMatch(text, /INSERT INTO share_invites/)
      return { rows: [] }
    })
    const response = await request(pool, '/invitations/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceType: 'buddy_streak',
        resourceId: '12',
        username: 'exact.user',
        permissions: { role: 'participant' },
      }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true })
  }
})

test('acceptance locks the invite and atomically grants medication-list permissions', async () => {
  const token = 'A'.repeat(43)
  const pool = fakePool(async (text, params) => {
    if (text.includes('FROM share_invites')) {
      assert.match(text, /FOR UPDATE/)
      assert.deepEqual(params, [hashInviteToken(token)])
      return {
        rows: [{
          id: '20',
          resource_type: 'medication_list',
          resource_id: '3',
          invited_by_user_id: 3,
          target_user_id: null,
          permission_payload: { role: 'editor', can_view_history: true },
          expires_at: '2099-01-01T00:00:00.000Z',
          max_uses: 2,
          use_count: 0,
          revoked_at: null,
        }],
      }
    }
    if (text.includes('FROM medication_lists')) return { rows: [{ owner_user_id: '3' }] }
    if (text.includes('INSERT INTO share_invite_acceptances')) {
      return { rows: [{ invite_id: '20' }] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/invitations/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    resourceType: 'medication_list',
    resourceId: '3',
    alreadyAccepted: false,
  })
  assert.ok(pool.calls.find(({ text }) => text.includes('INSERT INTO medication_list_shares')))
  assert.ok(pool.calls.find(({ text }) => text.includes('UPDATE medication_lists')))
  assert.ok(pool.calls.find(({ text }) => text.includes('use_count = use_count + 1')))
  assert.ok(pool.calls.find(({ text }) => text === 'COMMIT'))
})

test('buddy streak acceptance applies the requested role and account timezone', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM share_invites')) {
      return {
        rows: [{
          id: '21',
          resource_type: 'buddy_streak',
          resource_id: '32',
          invited_by_user_id: 3,
          target_user_id: 7,
          permission_payload: { role: 'observer' },
          expires_at: '2099-01-01T00:00:00.000Z',
          max_uses: 1,
          use_count: 0,
          revoked_at: null,
        }],
      }
    }
    if (text.includes('FROM buddy_streaks')) return { rows: [{ id: '32' }] }
    if (text.includes('INSERT INTO share_invite_acceptances')) {
      return { rows: [{ invite_id: '21' }] }
    }
    if (text.includes('SELECT timezone FROM users')) {
      return { rows: [{ timezone: 'Europe/Paris' }] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/invitations/21/accept', {
    method: 'POST',
  })

  assert.equal(response.status, 200)
  const membership = pool.calls.find(
    ({ text }) => text.includes('INSERT INTO buddy_streak_members'),
  )
  assert.deepEqual(membership.params, ['32', 7, 'observer', 'Europe/Paris'])
})

test('invitation creation never accepts an unowned resource id', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medication_lists')) return { rows: [] }
    assert.doesNotMatch(text, /INSERT INTO share_invites/)
    return { rows: [] }
  })
  const response = await request(pool, '/invitations/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceType: 'medication_list',
      resourceId: '999999',
      permissions: { role: 'viewer', canViewHistory: false },
    }),
  })

  assert.equal(response.status, 404)
})

test('invitation revocation is restricted to the inviter', async () => {
  const pool = fakePool(async (text, params) => {
    if (text.includes('UPDATE share_invites')) {
      assert.deepEqual(params, ['22', 7])
      return { rows: [{ id: '22' }] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/invitations/22', { method: 'DELETE' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.match(
    pool.calls.find(({ text }) => text.includes('UPDATE share_invites')).text,
    /invited_by_user_id = \$2/,
  )
})

test('a targeted recipient can decline an invitation', async () => {
  const pool = fakePool(async (text, params) => {
    if (text.includes('UPDATE share_invites')) {
      assert.deepEqual(params, ['22', 7])
      assert.match(text, /target_user_id = \$2/)
      return { rows: [{ id: '22' }] }
    }
    if (text.includes('UPDATE collaboration_events')) return { rows: [] }
    return { rows: [] }
  })

  const response = await request(pool, '/invitations/22/decline', { method: 'POST' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.ok(pool.calls.some(({ text }) => text === 'COMMIT'))
})

test('expired, revoked, exhausted, and wrong-target invites share a generic rejection', async () => {
  const variants = [
    { expires_at: '2000-01-01T00:00:00.000Z' },
    { revoked_at: '2026-01-01T00:00:00.000Z' },
    { use_count: 1 },
    { target_user_id: 99 },
  ]
  const bodies = []
  for (const variant of variants) {
    const pool = fakePool(async (text) => {
      if (!text.includes('FROM share_invites')) return { rows: [] }
      return {
        rows: [{
          id: '20',
          resource_type: 'buddy_streak',
          resource_id: '31',
          invited_by_user_id: 3,
          target_user_id: null,
          permission_payload: { role: 'observer' },
          expires_at: '2099-01-01T00:00:00.000Z',
          max_uses: 1,
          use_count: 0,
          revoked_at: null,
          ...variant,
        }],
      }
    })
    const response = await request(pool, '/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'B'.repeat(43) }),
    })
    assert.equal(response.status, 404)
    bodies.push(await response.json())
  }
  assert.ok(bodies.every((body) => body.error === 'This invitation is unavailable.'))
})
