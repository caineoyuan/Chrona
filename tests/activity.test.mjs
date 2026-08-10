import assert from 'node:assert/strict'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createActivityRouter } from '../server/activity.js'

process.env.JWT_SECRET = 'activity-test-secret'

async function request(pool, path, options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/activity', createActivityRouter(pool))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const token = jwt.sign({ uid: 7 }, process.env.JWT_SECRET)
    return await fetch(`http://127.0.0.1:${server.address().port}/api/activity${path}`, {
      ...options,
      headers: { Cookie: `chrona_token=${token}`, ...options.headers },
    })
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
}

function fakePool(handler) {
  const calls = []
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params })
      return handler(text, params)
    },
  }
}

test('activity is cursor paginated and exposes only minimal event payloads', async () => {
  const pool = fakePool(async (text, params) => {
    assert.match(text, /event\.recipient_user_id = \$1/)
    assert.deepEqual(params, [7, '50', 3])
    return {
      rows: [
        {
          id: 49,
          resource_type: 'buddy_streak',
          resource_id: 12,
          actor_user_id: 8,
          event_type: 'completed',
          payload: { periodKey: 'day:2026-08-09', privateNote: 'do not expose' },
          created_at: '2026-08-09T12:00:00.000Z',
          read_at: null,
          actor_username: 'friend',
          actor_display_username: 'Friend',
        },
        {
          id: 48,
          resource_type: 'buddy_streak',
          resource_id: 12,
          actor_user_id: 8,
          event_type: 'edited',
          payload: { definition: { name: 'private' } },
          created_at: '2026-08-09T11:00:00.000Z',
          read_at: null,
          actor_username: 'friend',
          actor_display_username: 'Friend',
        },
        { id: 47 },
      ],
    }
  })

  const response = await request(pool, '/?limit=2&cursor=50')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.nextCursor, '48')
  assert.deepEqual(body.activities[0].payload, { periodKey: 'day:2026-08-09' })
  assert.deepEqual(body.activities[1].payload, {})
  assert.equal(body.activities[0].actor.displayUsername, 'Friend')
})

test('mark-read operations are scoped to the authenticated recipient', async () => {
  const pool = fakePool(async (text, params) => {
    if (text.includes('COALESCE')) {
      assert.deepEqual(params, ['44', 7])
      return { rows: [{ id: 44, read_at: '2026-08-09T12:00:00.000Z' }] }
    }
    assert.match(text, /recipient_user_id = \$1/)
    assert.deepEqual(params, [7])
    return { rows: [], rowCount: 2 }
  })

  const one = await request(pool, '/44/read', { method: 'POST' })
  assert.equal(one.status, 200)
  assert.equal((await one.json()).id, '44')

  const all = await request(pool, '/read-all', { method: 'POST' })
  assert.equal(all.status, 200)
  assert.deepEqual(await all.json(), { ok: true, markedRead: 2 })
})
