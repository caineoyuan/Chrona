import assert from 'node:assert/strict'
import test from 'node:test'
import { createMedicationEventHub } from '../server/medication-events.js'

test('medication event hub targets authorized users and excludes the actor', () => {
  const hub = createMedicationEventHub()
  const ownerEvents = []
  const editorEvents = []
  const unrelatedEvents = []
  const unsubscribeOwner = hub.subscribe('1', (event) => ownerEvents.push(event))
  const unsubscribeEditor = hub.subscribe('2', (event) => editorEvents.push(event))
  const unsubscribeUnrelated = hub.subscribe('9', (event) => unrelatedEvents.push(event))
  const event = { change: 'updated', resourceId: '41', version: 6 }

  assert.equal(hub.hasSubscribers(), true)
  hub.publish(['1', '2'], event, '2')
  assert.deepEqual(ownerEvents, [event])
  assert.deepEqual(editorEvents, [])
  assert.deepEqual(unrelatedEvents, [])

  unsubscribeOwner()
  unsubscribeEditor()
  unsubscribeUnrelated()
  assert.equal(hub.hasSubscribers(), false)
})
