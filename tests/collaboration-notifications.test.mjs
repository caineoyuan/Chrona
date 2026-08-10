import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buddyReminderPhase,
  collaborationPushPayload,
  dispatchCollaborationPushes,
  queueAutomaticBuddyReminders,
  reminderBody,
} from '../server/collaboration-notifications.js'
import { insertCollaborationEvent } from '../server/collaboration-events.js'
import { runCollaborationNotificationTick } from '../server/push.js'

test('buddy reminder cadence uses the recipient IANA timezone', () => {
  const instant = new Date('2026-08-09T21:00:00.000Z')
  assert.equal(buddyReminderPhase(instant, 'America/New_York'), 'afternoon')
  assert.equal(buddyReminderPhase(instant, 'Europe/London'), 'evening')
  assert.equal(buddyReminderPhase(instant, 'Not/AZone'), null)
})

test('reminder copy names incomplete participant display usernames', () => {
  assert.equal(reminderBody(['Alex']), 'Alex still has an incomplete streak.')
  assert.equal(
    reminderBody(['Alex', 'Sam']),
    'Alex and Sam still have incomplete streaks.',
  )
})

test('manual nudge push copy escalates on the second and third reminder', () => {
  const event = {
    id: 1,
    resource_id: 12,
    event_type: 'ping',
    payload: { actorDisplayUsername: 'Alex' },
  }
  assert.equal(
    collaborationPushPayload(event).body,
    'Alex is nudging you to complete your streak.',
  )
  assert.equal(
    collaborationPushPayload({
      ...event,
      payload: { ...event.payload, nudgeNumber: 2 },
    }).body,
    'Alex is nudging you again to complete your streak.',
  )
  assert.equal(
    collaborationPushPayload({
      ...event,
      payload: { ...event.payload, nudgeNumber: 3 },
    }).body,
    'Alex is aggressively nudging you to complete your streak.',
  )
})

test('automatic reminders are durable, deduplicated, and push-requested', async () => {
  const calls = []
  const query = async (text, params = []) => {
    calls.push({ text, params })
    if (text.includes('recipient.user_id')) {
      return {
        rows: [{
          buddy_streak_id: 12,
          definition: {},
          recipient_user_id: 7,
          timezone: 'UTC',
        }],
      }
    }
    if (text.includes('member.active_at')) {
      return {
        rows: [
          {
            user_id: 7,
            role: 'participant',
            timezone: 'UTC',
            active_at: '2026-08-01T00:00:00.000Z',
            removed_at: null,
            username: 'alex',
            display_username: 'Alex',
          },
          {
            user_id: 8,
            role: 'participant',
            timezone: 'UTC',
            active_at: '2026-08-01T00:00:00.000Z',
            removed_at: null,
            username: 'sam',
            display_username: 'Sam',
          },
        ],
      }
    }
    if (text.includes('FROM buddy_streak_completions')) {
      return { rows: [{ user_id: 7, period_key: 'day:2026-08-09' }] }
    }
    if (text.includes('INSERT INTO collaboration_events')) {
      return { rows: [{ id: 44 }], rowCount: 1 }
    }
    return { rows: [] }
  }

  assert.equal(
    await queueAutomaticBuddyReminders(
      query,
      new Date('2026-08-09T17:00:00.000Z'),
    ),
    1,
  )
  const insert = calls.find(({ text }) => text.includes('INSERT INTO collaboration_events'))
  assert.equal(insert.params[4], 'automatic_reminder')
  assert.deepEqual(JSON.parse(insert.params[5]), {
    periodKey: 'day:2026-08-09',
    phase: 'afternoon',
    incompleteDisplayUsernames: ['Sam'],
  })
  assert.equal(
    insert.params[6],
    'buddy:12:recipient:7:period:day:2026-08-09:phase:afternoon',
  )
  assert.equal(insert.params[7], true)
})

test('push dispatch sends a minimal deep-link payload and marks the event', async () => {
  const calls = []
  const sent = []
  const queryFn = async (text, params = []) => {
    calls.push({ text, params })
    if (text.includes('WITH pending')) {
      return {
        rows: [{
          id: 55,
          resource_id: 12,
          event_type: 'automatic_reminder',
          payload: {
            periodKey: 'day:2026-08-09',
            phase: 'evening',
            incompleteDisplayUsernames: ['Alex'],
          },
        }],
      }
    }
    if (text.includes('FROM push_subscriptions')) {
      return { rows: [{ endpoint: 'endpoint', subscription: { endpoint: 'endpoint' } }] }
    }
    return { rows: [], rowCount: 1 }
  }
  const instant = new Date('2026-08-09T22:00:00.000Z')
  const count = await dispatchCollaborationPushes({
    queryFn,
    instant,
    sendNotification: async (subscription, payload) => sent.push({
      subscription,
      payload: JSON.parse(payload),
    }),
  })

  assert.equal(count, 1)
  assert.deepEqual(sent[0].payload, {
    title: 'Chrona buddy',
    body: 'Alex still has an incomplete streak.',
    tag: 'buddy-12-day:2026-08-09-evening',
    url: '/?buddyStreak=12',
  })
  assert.deepEqual(Object.keys(sent[0].payload), ['title', 'body', 'tag', 'url'])
  assert.ok(calls.some(({ text }) => text.includes('push_dispatched_at = $2')))
})

test('ordinary collaboration events remain in-app only by default', async () => {
  let params
  await insertCollaborationEvent({
    async query(_text, values) {
      params = values
      return { rows: [{ id: 1 }], rowCount: 1 }
    },
  }, {
    resourceType: 'buddy_streak',
    resourceId: 12,
    actorUserId: 7,
    recipientUserId: 8,
    eventType: 'edited',
  })
  assert.equal(params[7], false)
})

test('automatic in-app reminders run even when web push is not configured', async () => {
  let queued = 0
  let dispatched = 0
  await runCollaborationNotificationTick({
    queryFn: async () => ({ rows: [] }),
    pushEnabled: false,
    queueReminders: async () => { queued++ },
    dispatchPushes: async () => { dispatched++ },
  })
  assert.equal(queued, 1)
  assert.equal(dispatched, 0)
})
