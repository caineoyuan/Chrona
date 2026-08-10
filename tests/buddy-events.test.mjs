import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuddyEventHub } from '../server/buddy-events.js'

test('buddy event hub targets active members, excludes the actor, and unsubscribes', () => {
  const hub = createBuddyEventHub()
  const alice = []
  const bob = []
  hub.subscribe('7', (event) => alice.push(event))
  const unsubscribeBob = hub.subscribe('8', (event) => bob.push(event))
  const event = { change: 'completion', resourceId: '12', completed: true }

  hub.publish(['7', '8', '8'], event, '7')
  assert.deepEqual(alice, [])
  assert.deepEqual(bob, [event])

  unsubscribeBob()
  hub.publish(['8'], { ...event, completed: false })
  assert.equal(bob.length, 1)
})
