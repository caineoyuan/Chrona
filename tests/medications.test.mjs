import assert from 'node:assert/strict'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createMedicationsRouter } from '../server/medications.js'

process.env.JWT_SECRET = 'medications-test-secret'

function authCookie(userId = 7) {
  return `chrona_token=${jwt.sign({ uid: userId }, process.env.JWT_SECRET)}`
}

async function request(pool, path, options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/medications', createMedicationsRouter(pool, { sharing: true }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    return await fetch(`http://127.0.0.1:${address.port}/api/medications${path}`, {
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

const viewerRow = {
  id: '41',
  owner_user_id: 3,
  medication_data: {
    id: 'client-med-1',
    name: 'Metformin',
    times: ['08:00'],
    schedule: { type: 'daily' },
    scheduleAdjustmentPreference: 'yes',
    notifications: { enabled: true },
    paused: true,
    pausePeriods: [{ start: '2025-01-01T00:00:00.000Z', end: null }],
    inventory: { remaining: 12 },
    history: [{ id: 'must-not-leak' }],
  },
  version: 4,
  legacy_id: 'client-med-1',
  access_role: 'viewer',
  can_view_history: false,
  can_share: false,
  owner_username: 'Medication Owner',
  owner_timezone: 'America/New_York',
}

test('resource list strips embedded history for a viewer without history access', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications m')) {
      assert.match(text, /m\.medication_data/)
      assert.doesNotMatch(text, /medication_data - 'history'/)
      assert.match(text, /LEFT JOIN medication_list_shares s/)
      return { rows: [viewerRow] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/resources')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(body.medications[0].access, {
    role: 'viewer',
    canViewHistory: false,
    canViewSchedule: false,
    canShare: false,
    ownerUserId: '3',
    ownerUsername: 'Medication Owner',
    ownerTimezone: 'America/New_York',
  })
  assert.equal(body.medications[0].data.id, 'client-med-1')
  assert.equal('history' in body.medications[0].data, false)
  for (const key of ['times', 'schedule', 'scheduleAdjustmentPreference', 'notifications', 'paused', 'pausePeriods']) {
    assert.equal(key in body.medications[0].data, false)
  }
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false)
})

test('shared medication lists expose safe owner profiles and permissions', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM (')) {
      return {
        rows: [{
          id: 7,
          username: 'current.user',
          display_username: 'Current User',
          timezone: 'UTC',
          avatar_kind: null,
          avatar_value: null,
          avatar_color: null,
          avatar_file: null,
          role: 'owner',
          can_view_history: true,
        }, {
          id: 3,
          username: 'shared.owner',
          display_username: 'Shared Owner',
          timezone: 'UTC',
          avatar_kind: 'initial',
          avatar_value: null,
          avatar_color: '52AA8A',
          avatar_file: null,
          role: 'viewer',
          can_view_history: false,
        }],
      }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/lists')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.lists.length, 2)
  assert.deepEqual(body.lists[1], {
    ownerUserId: '3',
    username: 'Shared Owner',
    timezone: 'UTC',
    role: 'viewer',
    canViewHistory: false,
    avatar: {
      type: 'initial',
      initial: 'S',
      color: '52AA8A',
    },
  })
  assert.equal(JSON.stringify(body).includes('avatar_file'), false)
})

test('detail never includes history and history endpoint enforces can_view_history', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications m')) {
      assert.match(text, /m\.medication_data/)
      return { rows: [viewerRow] }
    }
    assert.doesNotMatch(text, /FROM medication_dose_events/)
    return { rows: [] }
  })

  const detail = await request(pool, '/resources/41')
  assert.equal(detail.status, 200)
  assert.equal(JSON.stringify(await detail.json()).includes('must-not-leak'), false)

  const history = await request(pool, '/resources/41/dose-events')
  assert.equal(history.status, 403)
  assert.deepEqual(await history.json(), { error: 'Medication history is not shared.' })
})

test('optimistic updates reject stale versions before writing', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications m')) {
      return {
        rows: [{
          ...viewerRow,
          access_role: 'editor',
          can_view_history: true,
          version: 9,
        }],
      }
    }
    assert.doesNotMatch(text, /UPDATE medications/)
    return { rows: [] }
  })

  const response = await request(pool, '/resources/41', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 8,
      medication: { id: 'client-med-1', name: 'Changed' },
    }),
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'Medication version conflict.',
    currentVersion: 9,
  })
  assert.ok(pool.calls.some(({ text }) => text === 'ROLLBACK') === false)
  assert.ok(pool.calls.some(({ text }) => text === 'COMMIT'))
})

test('list-only editors cannot overwrite schedule fields hidden from them', async () => {
  let savedData
  const current = {
    ...viewerRow,
    access_role: 'editor',
    can_view_history: false,
  }
  const pool = fakePool(async (text, params) => {
    if (text.includes('FROM medications m')) return { rows: [current] }
    if (text.includes('UPDATE medications')) {
      savedData = JSON.parse(params[1])
      return {
        rows: [{
          ...current,
          medication_data: savedData,
          version: 5,
        }],
      }
    }
    if (text.includes('FROM medications') && text.includes('owner_user_id')) {
      return {
        rows: [{
          ...current,
          medication_data: savedData,
          legacy_position: 0,
          created_at: new Date(),
          updated_at: new Date(),
          version: 5,
        }],
      }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/resources/41', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 4,
      medication: {
        id: 'client-med-1',
        name: 'Updated name',
        times: ['21:00'],
        schedule: { type: 'weekly' },
        paused: false,
      },
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(savedData.name, 'Updated name')
  assert.deepEqual(savedData.times, viewerRow.medication_data.times)
  assert.deepEqual(savedData.schedule, viewerRow.medication_data.schedule)
  assert.equal(savedData.scheduleAdjustmentPreference, viewerRow.medication_data.scheduleAdjustmentPreference)
  assert.deepEqual(savedData.notifications, viewerRow.medication_data.notifications)
  assert.equal(savedData.paused, viewerRow.medication_data.paused)
  assert.deepEqual(savedData.pausePeriods, viewerRow.medication_data.pausePeriods)
})

test('viewers cannot mutate medication resources', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications m')) return { rows: [viewerRow] }
    assert.doesNotMatch(text, /UPDATE medications/)
    return { rows: [] }
  })

  const response = await request(pool, '/resources/41', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 4,
      medication: { id: 'client-med-1', name: 'Changed' },
    }),
  })

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Medication is read-only.' })
})

test('editors with history access can create a dose event and advance the resource version', async () => {
  const createdEvent = {
    id: '101',
    medication_id: '41',
    legacy_id: 'dose-client-1',
    scheduled_at: '2026-03-01T17:00:00.000Z',
    taken_at: '2026-03-01T17:02:00.000Z',
    skipped_at: null,
    original_scheduled_at: null,
    status: 'on-time',
    injection_site: null,
  }
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications m')) {
      return {
        rows: [{
          ...viewerRow,
          access_role: 'editor',
          can_view_history: true,
        }],
      }
    }
    if (text.includes('INSERT INTO medication_dose_events')) {
      return { rows: [createdEvent] }
    }
    if (text.includes('UPDATE medications') && text.includes('RETURNING version')) {
      return { rows: [{ version: 5 }] }
    }
    if (text.includes('FROM medications') && text.includes('owner_user_id = $1')) {
      return { rows: [] }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/resources/41/dose-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 4,
      doseEvent: {
        id: 'dose-client-1',
        scheduledAt: '2026-03-01T17:00:00.000Z',
        takenAt: '2026-03-01T17:02:00.000Z',
        status: 'on-time',
      },
    }),
  })
  const body = await response.json()

  assert.equal(response.status, 201)
  assert.equal(body.version, 5)
  assert.equal(body.doseEvent.id, 'dose-client-1')
  assert.equal(pool.calls.some(({ text }) => text.includes('user_medications')), false)
})

test('legacy GET reads details and history from the canonical medication document', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medications') && text.includes('owner_user_id')) {
      return {
        rows: [{
          id: '41',
          medication_data: {
            id: 'client-med-1',
            name: 'Metformin',
            schedule: { type: 'weekly', weekdays: [1] },
            inventory: { remaining: 12, unit: 'tablets' },
            history: [{
              id: 'dose-client-1',
              scheduledAt: '2026-02-01T09:00:00.000Z',
              takenAt: '2026-02-01T09:05:00.000Z',
              skippedAt: null,
              originalScheduledAt: null,
              status: 'on-time',
              injectionSite: null,
            }],
          },
          legacy_id: 'client-med-1',
          legacy_position: 1,
          version: 2,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        }],
      }
    }
    assert.doesNotMatch(text, /FROM medication_dose_events/)
    return { rows: [] }
  })

  const response = await request(pool, '/')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.medications[0].id, 'client-med-1')
  assert.deepEqual(body.medications[0].schedule, {
    type: 'weekly',
    weekdays: [1],
  })
  assert.deepEqual(body.medications[0].inventory, {
    remaining: 12,
    unit: 'tablets',
  })
  assert.deepEqual(body.medications[0].history[0], {
    id: 'dose-client-1',
    scheduledAt: '2026-02-01T09:00:00.000Z',
    takenAt: '2026-02-01T09:05:00.000Z',
    skippedAt: null,
    originalScheduledAt: null,
    status: 'on-time',
    injectionSite: null,
  })
})

test('legacy PUT stores history only in canonical documents transactionally', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('SELECT id, legacy_id, legacy_position') && text.includes('FROM medications')) {
      return { rows: [] }
    }
    if (text.includes('INSERT INTO medications')) return { rows: [{ id: '51' }] }
    assert.doesNotMatch(text, /medication_dose_events/)
    return { rows: [] }
  })

  const medications = [{
    id: 'stable-med-id',
    name: 'Lisinopril',
    schedule: { type: 'daily' },
    inventory: { remaining: 30 },
    history: [{
      id: 'stable-dose-id',
      scheduledAt: '2026-03-01T17:00:00.000Z',
      takenAt: '2026-03-01T17:02:00.000Z',
      status: 'on-time',
    }],
  }]

  const response = await request(pool, '/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ medications }),
  })

  assert.equal(response.status, 200)
  assert.ok(pool.calls.some(({ text }) => text.includes('INSERT INTO medications')))
  const canonicalWrite = pool.calls.find(({ text }) => text.includes('INSERT INTO medications'))
  assert.deepEqual(JSON.parse(canonicalWrite.params[1]).history, [{
    ...medications[0].history[0],
    skippedAt: null,
    originalScheduledAt: null,
    injectionSite: null,
  }])
  assert.equal(pool.calls.some(({ text }) => text.includes('user_medications')), false)
  assert.ok(pool.calls.some(({ text }) => text === 'COMMIT'))
})

test('owners can list medication-list members and pending invitations', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('SELECT version FROM medication_lists')) {
      return { rows: [{ version: 4 }] }
    }
    if (text.includes('FROM medication_list_shares share')) {
      return {
        rows: [{
          id: '9',
          username: 'editor.user',
          display_username: 'Editor User',
          timezone: 'UTC',
          avatar_kind: null,
          avatar_value: null,
          avatar_color: null,
          avatar_file: null,
          role: 'editor',
          can_view_history: false,
        }],
      }
    }
    if (text.includes('FROM share_invites invite')) {
      return {
        rows: [{
          id: '22',
          target_user_id: null,
          display_username: null,
          permission_payload: { role: 'viewer', can_view_history: true },
          expires_at: '2099-01-01T00:00:00.000Z',
          max_uses: 3,
          use_count: 1,
        }],
      }
    }
    return { rows: [] }
  })

  const response = await request(pool, '/list/shares')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual({
    ...body.members[0],
    avatar: undefined,
  }, {
    userId: '9',
    username: 'Editor User',
    role: 'editor',
    canViewHistory: false,
    avatar: undefined,
  })
  assert.equal(body.resourceId, '7')
  assert.equal(body.version, 4)
  assert.equal(body.members[0].avatar.type, 'initial')
  assert.deepEqual(body.invitations[0].permissions, {
    role: 'viewer',
    canViewHistory: true,
  })
})

test('list share revocation reports a list version conflict before removing access', async () => {
  const pool = fakePool(async (text) => {
    if (text.includes('FROM medication_lists')) return { rows: [{ version: 9 }] }
    assert.doesNotMatch(text, /UPDATE medication_list_shares/)
    return { rows: [] }
  })

  const response = await request(pool, '/list/shares/9', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 8 }),
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'Medication version conflict.',
    currentVersion: 9,
  })
})
