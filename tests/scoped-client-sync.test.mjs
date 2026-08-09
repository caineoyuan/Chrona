import assert from 'node:assert/strict'
import test from 'node:test'
import {
  medicationHistoryForResource,
  medicationResourceClient,
  privateMedicationSnapshot,
} from '../src/medira/scoped-medications.js'

test('medication client writes only resource-scoped endpoints with versions', async () => {
  const calls = []
  const request = async (path, options = {}) => {
    calls.push({ path, options })
    if (options.method === 'POST' && path.endsWith('/dose-events')) {
      return { version: 3, doseEvent: { resourceEventId: '91' } }
    }
    return { medication: { id: '41', version: 2 } }
  }
  const client = medicationResourceClient(request)

  await client.update('41', 1, { id: 'private-id', name: 'Updated' })
  await client.createDoseEvent('41', 2, {
    id: 'dose-id',
    scheduledAt: '2026-08-09T12:00:00.000Z',
  })

  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/medications/resources/41',
    '/api/medications/resources/41/dose-events',
  ])
  assert.equal(JSON.parse(calls[0].options.body).version, 1)
  assert.equal(JSON.parse(calls[1].options.body).version, 2)
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

test('shared medication history is not fetched without explicit permission', async () => {
  let historyRequests = 0
  const history = await medicationHistoryForResource({
    async listDoseEvents() {
      historyRequests++
      return { doseEvents: [{ id: 'must-not-fetch' }] }
    },
  }, {
    id: '42',
    version: 1,
    access: { role: 'viewer', canViewHistory: false },
    data: { id: 'shared', name: 'Shared medication' },
  })

  assert.equal(historyRequests, 0)
  assert.deepEqual(history, [])
})
