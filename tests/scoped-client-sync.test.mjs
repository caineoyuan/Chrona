import assert from 'node:assert/strict'
import test from 'node:test'
import { buddyStreakClient } from '../src/buddy-streak-client.js'
import {
  medicationResourceClient,
  privateMedicationSnapshot,
} from '../src/medira/scoped-medications.js'

test('medication client atomically writes the complete versioned document', async () => {
  const calls = []
  const request = async (path, options = {}) => {
    calls.push({ path, options })
    return { medication: { id: '41', version: 2 } }
  }
  const client = medicationResourceClient(request)

  await client.update('41', 1, {
    id: 'private-id',
    name: 'Updated',
    history: [{
      id: 'dose-id',
      scheduledAt: '2026-08-09T12:00:00.000Z',
    }],
  })

  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/medications/resources/41',
  ])
  const payload = JSON.parse(calls[0].options.body)
  assert.equal(payload.version, 1)
  assert.equal(payload.medication.history[0].id, 'dose-id')
  assert.ok(calls.every(({ path }) => path !== '/api/medications'))
})

test('private cache excludes shared medication data and server identifiers', () => {
  const snapshot = privateMedicationSnapshot([
    {
      id: 'private',
      name: 'Private',
      resourceId: '41',
      resourceVersion: 3,
      resourceAccess: { role: 'owner', canViewHistory: true },
      history: [{ id: 'dose', resourceEventId: '91', status: 'taken' }],
    },
    {
      id: 'shared',
      name: 'Shared secret',
      resourceId: '42',
      resourceAccess: { role: 'viewer', canViewHistory: false },
      history: [],
    },
  ])

  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].id, 'private')
  assert.equal('resourceId' in snapshot[0], false)
  assert.equal('resourceEventId' in snapshot[0].history[0], false)
  assert.equal(JSON.stringify(snapshot).includes('Shared secret'), false)
})

test('buddy client propagates 409 conflicts for hooks to refetch', async () => {
  const conflict = Object.assign(new Error('changed'), {
    status: 409,
    data: { currentVersion: 6 },
  })
  const client = buddyStreakClient(async (path, options) => {
    assert.equal(path, '/api/buddy-streaks/12')
    assert.deepEqual(JSON.parse(options.body), {
      version: 5,
      definition: { name: 'Daily' },
    })
    throw conflict
  })

  await assert.rejects(
    client.update('12', 5, { name: 'Daily' }),
    (error) => error.status === 409 && error.data.currentVersion === 6,
  )
})
