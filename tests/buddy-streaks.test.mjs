import assert from 'node:assert/strict'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createBuddyStreaksRouter } from '../server/buddy-streaks.js'

process.env.JWT_SECRET = 'buddy-test-secret'

function fakePool(handler) {
  const calls = []
  const pool = {
    async query(text, params) {
      calls.push({ text, params })
      return handler(text, params, calls)
    },
  }
  pool.connect = async () => ({
    query: pool.query,
    release() {},
  })
  pool.calls = calls
  return pool
}

async function request(pool, path, options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/buddy-streaks', createBuddyStreaksRouter(pool))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const { authenticated = true, ...fetchOptions } = options
    const token = jwt.sign({ uid: 7 }, process.env.JWT_SECRET)
    return await fetch(
      `http://127.0.0.1:${server.address().port}/api/buddy-streaks${path}`,
      {
        ...fetchOptions,
        headers: {
          ...(authenticated ? { Cookie: `chrona_token=${token}` } : {}),
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
    )
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
}

test('any active participant can update and receives an optimistic conflict', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'participant',
          timezone: 'UTC',
          definition: { name: 'Old' },
          version: 4,
        }],
      }
    }
    if (text.includes('UPDATE buddy_streaks')) return { rows: [] }
    if (text.includes('SELECT version FROM buddy_streaks')) {
      return { rows: [{ version: 5 }] }
    }
    return { rows: [] }
  })
  const response = await request(pool, '/12', {
    method: 'PATCH',
    body: JSON.stringify({ version: 4, definition: { name: 'New' } }),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'Buddy streak has changed.',
    currentVersion: 5,
  })
  assert.deepEqual(
    pool.calls.find(({ text }) => text.includes('UPDATE buddy_streaks')).params,
    [JSON.stringify({ name: 'New' }), '12', 4],
  )
})

test('get returns participant and observer membership with derived group completion', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('SELECT streak.id')) {
      return {
        rows: [{
          id: '12',
          definition: { name: 'Shared' },
          version: 2,
          created_by_user_id: 3,
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-03T00:00:00.000Z',
          legacy_set_id: null,
          requesting_role: 'participant',
        }],
      }
    }
    if (text.includes('JOIN users ON users.id')) {
      return {
        rows: [
          {
            user_id: 7,
            role: 'participant',
            timezone: 'UTC',
            joined_at: '2026-08-01T00:00:00.000Z',
            active_at: '2026-08-01T00:00:00.000Z',
            removed_at: null,
            username: 'participant',
            display_username: 'Participant',
          },
          {
            user_id: 8,
            role: 'observer',
            timezone: 'Europe/Paris',
            joined_at: '2026-08-01T00:00:00.000Z',
            active_at: '2026-08-01T00:00:00.000Z',
            removed_at: null,
            username: 'observer',
            display_username: 'Observer',
          },
        ],
      }
    }
    if (text.includes('FROM buddy_streak_completions')) {
      return {
        rows: [{
          user_id: 7,
          period_key: 'day:2026-08-02',
          local_completed_at: '2026-08-02 09:00:00',
          completed_at: '2026-08-02T09:00:00.000Z',
          source: 'manual',
        }],
      }
    }
    return { rows: [] }
  })
  const response = await request(pool, '/12')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.canAdminister, true)
  assert.deepEqual(body.members.map(({ role }) => role), ['participant', 'observer'])
  assert.equal(body.members[0].effectiveFrom, '2026-08-01')
  assert.deepEqual(body.occurrences[0], {
    periodKey: 'day:2026-08-02',
    participantIds: ['7'],
    completedParticipantIds: ['7'],
    complete: true,
  })
})

test('observers can read membership data but cannot administer', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'observer',
          timezone: 'UTC',
          definition: { name: 'Shared' },
          version: 1,
        }],
      }
    }
    assert.doesNotMatch(text, /UPDATE buddy_streaks/)
    return { rows: [] }
  })
  const response = await request(pool, '/12', {
    method: 'PATCH',
    body: JSON.stringify({ version: 1, definition: { name: 'Nope' } }),
  })
  assert.equal(response.status, 403)
})

test('observers cannot complete a shared streak', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'observer',
          timezone: 'UTC',
          definition: { name: 'Shared' },
          version: 1,
        }],
      }
    }
    assert.doesNotMatch(text, /buddy_streak_completions|collaboration_events/)
    return { rows: [] }
  })

  const response = await request(pool, '/12/completion', { method: 'PUT' })

  assert.equal(response.status, 403)
  assert.equal(
    pool.calls.some(({ text }) => text.includes('INSERT INTO buddy_streak_completions')),
    false,
  )
})

test('ping route requires authentication', async () => {
    const pool = fakePool(async () => {
      assert.fail('unauthenticated pings must not query the database')
    })
    const response = await request(pool, '/12/ping', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ recipientUserId: '8' }),
    })
    assert.equal(response.status, 401)
})

test('observers can ping incomplete participants and queue push delivery', async () => {
    const pool = fakePool(async (text) => {
      if (text.includes('FROM buddy_streak_members member') &&
          text.includes('JOIN buddy_streaks')) {
        return {
          rows: [{
            role: 'observer',
            timezone: 'UTC',
            definition: { name: 'Shared' },
            version: 1,
          }],
        }
      }
      if (text.includes('FOR UPDATE OF member')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            username: 'friend',
            display_username: 'Friend',
            status: 'active',
          }],
        }
      }
      if (text.includes('FROM buddy_streak_completions')) return { rows: [] }
      if (text.includes('AS ping_count')) {
        return { rows: [{ ping_count: 2, retry_after: 1200 }] }
      }
      if (text.includes('SELECT username, display_username')) {
        return { rows: [{ username: 'watcher', display_username: 'Watcher' }] }
      }
      if (text.includes('INSERT INTO collaboration_events')) {
        return { rows: [{ id: 91 }], rowCount: 1 }
      }
      return { rows: [] }
    })

    const response = await request(pool, '/12/ping', {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: '8' }),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      ok: true,
      eventId: '91',
      nudgeNumber: 3,
    })
    assert.ok(pool.calls.some(({ text }) => text.includes('pg_advisory_xact_lock')))
    assert.ok(pool.calls.some(({ text }) => text.includes('INSERT INTO ping_rate_limits')))
    const event = pool.calls.find(({ text }) =>
      text.includes('INSERT INTO collaboration_events'))
    assert.equal(event.params[4], 'ping')
    assert.equal(event.params[7], true)
})

test('ping limit is enforced before inserting under the transaction lock', async () => {
    const pool = fakePool(async (text) => {
      if (text.includes('FROM buddy_streak_members member') &&
          text.includes('JOIN buddy_streaks')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            definition: {},
            version: 1,
          }],
        }
      }
      if (text.includes('FOR UPDATE OF member')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            username: 'friend',
            display_username: 'Friend',
            status: 'active',
          }],
        }
      }
      if (text.includes('FROM buddy_streak_completions')) return { rows: [] }
      if (text.includes('AS ping_count')) {
        return { rows: [{ ping_count: 3, retry_after: 900 }] }
      }
      return { rows: [] }
    })

    const response = await request(pool, '/12/ping', {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: '8' }),
    })

    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '900')
    assert.equal(
      pool.calls.some(({ text }) => text.includes('INSERT INTO ping_rate_limits')),
      false,
    )
})

test('ping rejects self and already-completed recipients', async () => {
    const pool = fakePool(async (text) => {
      if (text.includes('FROM buddy_streak_members member') &&
          text.includes('JOIN buddy_streaks')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            definition: {},
            version: 1,
          }],
        }
      }
      if (text.includes('FOR UPDATE OF member')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            username: 'friend',
            display_username: 'Friend',
            status: 'active',
          }],
        }
      }
      if (text.includes('FROM buddy_streak_completions')) {
        return { rows: [{ completion_count: 1 }] }
      }
      return { rows: [] }
    })

    const self = await request(pool, '/12/ping', {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: '7' }),
    })
    assert.equal(self.status, 400)

    const completed = await request(pool, '/12/ping', {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: '8' }),
    })
    assert.equal(completed.status, 409)
})

test('completion and undo derive the same current key from member timezone', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'participant',
          timezone: 'Pacific/Kiritimati',
          definition: { name: 'Daily' },
          version: 1,
        }],
      }
    }
    return { rows: [] }
  })

  const completed = await request(pool, '/12/completion', { method: 'PUT' })
  const completedBody = await completed.json()
  const undone = await request(pool, '/12/completion', { method: 'DELETE' })
  const undoneBody = await undone.json()

  assert.equal(completed.status, 200)
  assert.equal(undone.status, 200)
  assert.match(completedBody.periodKey, /^day:\d{4}-\d{2}-\d{2}$/)
  assert.equal(undoneBody.periodKey, completedBody.periodKey)
  assert.ok(pool.calls.some(({ text }) =>
    text.includes('INSERT INTO buddy_streak_completions')))
  assert.ok(pool.calls.some(({ text }) =>
    text.includes('INSERT INTO collaboration_events')))
  assert.ok(pool.calls.some(({ text }) =>
    text.includes('DELETE FROM buddy_streak_completions')))
})

test('participants can add and remove a dated completion from shared history', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'participant',
          timezone: 'UTC',
          definition: {
            name: 'Daily',
            createdAt: '2026-08-01T12:00:00.000Z',
          },
          version: 1,
        }],
      }
    }
    return { rows: [] }
  })

  const added = await request(pool, '/12/completions/2026-08-03', { method: 'PUT' })
  const removed = await request(pool, '/12/completions/2026-08-03', { method: 'DELETE' })

  assert.equal(added.status, 200)
  assert.equal(removed.status, 200)
  assert.ok(pool.calls.some(({ text, params }) =>
    text.includes('INSERT INTO buddy_streak_completions') &&
    params[2] === 'day:2026-08-03' &&
    params[3] === '2026-08-03' &&
    params[4] === '2026-08-03 12:00:00' &&
    text.includes('completion_date')))
  assert.ok(pool.calls.some(({ text, params }) =>
    text.includes('DELETE FROM buddy_streak_completions') &&
    params[2] === 'day:2026-08-03' &&
    params[3] === '2026-08-03' &&
    text.includes('completion_date = $4')))
})

test('weekly dated completions use independent completion-date keys', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'participant',
          timezone: 'UTC',
          definition: {
            name: 'Gym',
            createdAt: '2026-08-01T12:00:00.000Z',
            schedule: { mode: 'weekly', timesPerWeek: 6 },
          },
          version: 1,
        }],
      }
    }
    return { rows: [] }
  })

  await request(pool, '/12/completions/2026-08-03', { method: 'PUT' })
  await request(pool, '/12/completions/2026-08-04', { method: 'PUT' })
  await request(pool, '/12/completions/2026-08-03', { method: 'DELETE' })

  const inserts = pool.calls.filter(({ text }) =>
    text.includes('INSERT INTO buddy_streak_completions'))
  assert.deepEqual(inserts.map(({ params }) => params.slice(2, 5)), [
    ['week:2026-08-02', '2026-08-03', '2026-08-03 12:00:00'],
    ['week:2026-08-02', '2026-08-04', '2026-08-04 12:00:00'],
  ])
  assert.ok(inserts.every(({ text }) =>
    text.includes('buddy_streak_id, user_id, period_key, completion_date')))
  const deletion = pool.calls.find(({ text, params }) =>
    text.includes('DELETE FROM buddy_streak_completions') &&
    params[3] === '2026-08-03')
  assert.ok(deletion)
  assert.match(deletion.text, /completion_date = \$4/)
})

test('participants can remove a member and create a private removal activity', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'participant',
          timezone: 'UTC',
          definition: { name: 'Shared' },
          version: 2,
        }],
      }
    }
    if (text.includes('SELECT user_id FROM buddy_streak_members')) {
      return { rows: [{ user_id: 8 }] }
    }
    if (text.includes('UPDATE buddy_streaks')) return { rows: [{ version: 3 }] }
    return { rows: [] }
  })

  const response = await request(pool, '/12/members/8', {
    method: 'DELETE',
    body: JSON.stringify({ version: 2 }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    removedUserId: '8',
    version: 3,
  })
  const event = pool.calls.find(({ text }) =>
    text.includes('INSERT INTO collaboration_events'))
  assert.deepEqual(event.params.slice(0, 6), [
    'buddy_streak',
    '12',
    7,
    '8',
    'removed',
    '{}',
  ])
})

test('spectators can leave a buddy streak themselves', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM buddy_streak_members member')) {
      return {
        rows: [{
          role: 'observer',
          timezone: 'UTC',
          definition: { name: 'Shared' },
          version: 2,
        }],
      }
    }
    if (text.includes('SELECT user_id FROM buddy_streak_members')) {
      return { rows: [{ user_id: 7 }] }
    }
    if (text.includes('UPDATE buddy_streaks')) return { rows: [{ version: 3 }] }
    return { rows: [] }
  })

  const response = await request(pool, '/12/members/7', {
    method: 'DELETE',
    body: JSON.stringify({ version: 2 }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    removedUserId: '7',
    version: 3,
  })
})

  test('participants can switch another member between buddy and spectator', async () => {
    const pool = fakePool(async (text) => {
      if (text.includes('SELECT streak.id')) {
        return {
          rows: [{
            id: '12',
            definition: { name: 'Shared' },
            version: 3,
            created_by_user_id: 7,
            requesting_role: 'participant',
          }],
        }
      }
      if (text.includes('FROM buddy_streak_members member') &&
          text.includes('JOIN buddy_streaks')) {
        return {
          rows: [{
            role: 'participant',
            timezone: 'UTC',
            definition: { name: 'Shared' },
            version: 2,
          }],
        }
      }
      if (text.includes('SELECT role FROM buddy_streak_members')) {
        return { rows: [{ role: 'observer' }] }
      }
      if (text.includes('UPDATE buddy_streaks')) {
        return { rows: [{ version: 3 }] }
      }
      if (text.includes('JOIN users ON users.id')) {
        return {
          rows: [
            {
              user_id: 7,
              role: 'participant',
              timezone: 'UTC',
              username: 'owner',
              display_username: 'Owner',
            },
            {
              user_id: 8,
              role: 'participant',
              timezone: 'UTC',
              username: 'friend',
              display_username: 'Friend',
            },
          ],
        }
      }
      return { rows: [] }
    })

    const response = await request(pool, '/12/members/8', {
      method: 'PATCH',
      body: JSON.stringify({ version: 2, role: 'participant' }),
    })

    assert.equal(response.status, 200)
    const roleUpdate = pool.calls.find(({ text }) =>
      text.includes('SET role = $3'))
    assert.deepEqual(roleUpdate.params, ['12', '8', 'participant'])
  })

  test('observers cannot change member permissions', async () => {
    const pool = fakePool(async (text) => {
      if (text.includes('FROM buddy_streak_members member')) {
        return {
          rows: [{
            role: 'observer',
            timezone: 'UTC',
            definition: {},
            version: 2,
          }],
        }
      }
      return { rows: [] }
    })

    const response = await request(pool, '/12/members/8', {
      method: 'PATCH',
      body: JSON.stringify({ version: 2, role: 'participant' }),
    })

    assert.equal(response.status, 403)
    assert.equal(
      pool.calls.some(({ text }) => text.includes('SET role = $3')),
      false,
    )
  })
