import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { reminderPlan } from '../src/notify.js'
import {
  dispatchMedicationReminders,
  dispatchStreakReminders,
  streakReminderDate,
  streakReminderPhase,
} from '../server/push.js'

test('server dispatches medication reminders without an open app', async () => {
  const calls = []
  const sent = []
  const queryFn = async (text, params) => {
    calls.push({ text, params })
    if (text.includes('FROM medications medication')) {
      return {
        rows: [{
          id: 12,
          legacy_id: 'medication-12',
          owner_timezone: 'UTC',
          medication_data: {
            id: 'medication-12',
            name: 'Medication',
            dose: '10 mg',
            createdAt: '2026-10-01T00:00:00.000Z',
            times: ['09:00'],
            schedule: {
              type: 'daily',
              intervalHours: 24,
              timezone: 'UTC',
              weekdays: [],
              changes: [],
            },
            notifications: { enabled: true, advanceMinutes: [0] },
            history: [],
            pausePeriods: [],
          },
        }],
      }
    }
    return { rows: [] }
  }
  const subscriptions = [{
    endpoint: 'ios-endpoint',
    user_id: 7,
    subscription: { endpoint: 'ios-endpoint' },
    reminders: [],
  }]

  assert.equal(await dispatchMedicationReminders({
    subscriptions,
    queryFn,
    instant: new Date('2026-10-02T09:00:20.000Z'),
    sendNotification: async (_subscription, payload, options) => {
      sent.push({ payload: JSON.parse(payload), options })
    },
  }), 1)
  assert.equal(sent[0].payload.title, 'Medication')
  assert.deepEqual(sent[0].options, { TTL: 3600, urgency: 'high' })
  assert.ok(calls.some(({ text }) => text.includes('FROM medications medication')))
})

test('server retains failed medication pushes for closed-app retry', async () => {
  const updates = []
  let attempts = 0
  const reminder = {
    id: 'retry-reminder',
    alertAt: '2026-10-02T08:59:00.000Z',
    title: 'Medication',
    body: 'Scheduled dose',
    tag: 'dose-retry',
  }
  const queryFn = async (text, params) => {
    if (text.includes('FROM medications medication')) return { rows: [] }
    if (text.includes('UPDATE push_subscriptions')) updates.push(params)
    return { rows: [] }
  }

  assert.equal(await dispatchMedicationReminders({
    subscriptions: [{
      endpoint: 'ios-endpoint',
      user_id: 7,
      subscription: { endpoint: 'ios-endpoint' },
      reminders: [reminder],
    }],
    queryFn,
    instant: new Date('2026-10-02T09:00:20.000Z'),
    sendNotification: async () => {
      attempts++
      throw new Error('Temporary APNs failure')
    },
  }), 0)
  assert.equal(attempts, 1)
  assert.equal(updates.length, 0)
})

test('server drops stale future plans when medication schedules change', async () => {
  const updates = []
  const queryFn = async (text, params) => {
    if (text.includes('FROM medications medication')) return { rows: [] }
    if (text.includes('UPDATE push_subscriptions')) updates.push(params)
    return { rows: [] }
  }
  await dispatchMedicationReminders({
    subscriptions: [{
      endpoint: 'ios-endpoint',
      user_id: 7,
      subscription: { endpoint: 'ios-endpoint' },
      reminders: [{
        id: 'deleted-medication',
        alertAt: '2026-10-03T09:00:00.000Z',
        tag: 'deleted-medication',
      }],
    }],
    queryFn,
    instant: new Date('2026-10-02T09:00:20.000Z'),
    sendNotification: async () => {},
  })

  assert.deepEqual(JSON.parse(updates[0][0]), [])
})

test('server uses owner timezone for legacy medication schedules', async () => {
  const sent = []
  const queryFn = async (text) => {
    if (text.includes('FROM medications medication')) {
      return {
        rows: [{
          id: 12,
          legacy_id: 'legacy-medication',
          owner_timezone: 'America/Los_Angeles',
          medication_data: {
            name: 'Legacy medication',
            createdAt: '2026-10-01T00:00:00.000Z',
            times: ['09:00'],
            schedule: { type: 'daily', weekdays: [], changes: [] },
            notifications: { enabled: true, advanceMinutes: [0] },
            history: [],
            pausePeriods: [],
          },
        }],
      }
    }
    return { rows: [] }
  }

  await dispatchMedicationReminders({
    subscriptions: [{
      endpoint: 'ios-endpoint',
      user_id: 7,
      tz: 'America/Los_Angeles',
      subscription: { endpoint: 'ios-endpoint' },
      reminders: [],
    }],
    queryFn,
    instant: new Date('2026-10-02T16:00:20.000Z'),
    sendNotification: async (_subscription, payload) => {
      sent.push(JSON.parse(payload))
    },
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, 'Legacy medication')
})

test('streak reminders run at 9 AM and five minutes before the deadline', () => {
  assert.equal(streakReminderPhase({ hh: '09', mm: '00' }), 'morning')
  assert.equal(streakReminderPhase({ hh: '00', mm: '25' }), 'deadline')
  assert.equal(streakReminderPhase({ hh: '22', mm: '00' }), null)

  const plan = reminderPlan(new Date(2026, 7, 18, 1, 0))
  assert.equal(plan[0].at.getHours(), 9)
  assert.equal(plan[0].at.getMinutes(), 0)
  assert.equal(plan[1].at.getDate(), 19)
  assert.equal(plan[1].at.getHours(), 0)
  assert.equal(plan[1].at.getMinutes(), 25)
})

test('the after-midnight deadline reminder belongs to the prior streak date', () => {
  const date = streakReminderDate({ y: 2026, m: 8, d: 19 }, 'deadline')
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 7)
  assert.equal(date.getDate(), 18)
})

test('server dispatch sends morning and deadline pushes in each device timezone', async () => {
  const sets = [{
    id: 'daily-streak',
    name: 'Daily streak',
    trackStreak: true,
    notify: true,
    schedule: [],
    completions: {},
    freezes: {},
  }, {
    id: 'ordinary-task',
    name: 'No streak',
    trackStreak: false,
    notify: true,
    schedule: [],
  }]
  const sent = []
  const queryFn = async () => ({ rows: [{ sets }] })
  const subscriptions = [{
    endpoint: 'ios-endpoint',
    user_id: 7,
    subscription: { endpoint: 'ios-endpoint' },
    tz: 'America/Los_Angeles',
  }]

  assert.equal(await dispatchStreakReminders({
    subscriptions,
    queryFn,
    instant: new Date('2026-08-18T16:00:00.000Z'),
    sendNotification: async (_subscription, payload, options) => {
      sent.push({ payload: JSON.parse(payload), options })
    },
  }), 1)
  assert.match(sent[0].payload.body, /today/)
  assert.equal(sent[0].payload.tag, 'daily-streak-2026-08-18-morning')
  assert.deepEqual(sent[0].options, { TTL: 3600, urgency: 'high' })

  sent.length = 0
  assert.equal(await dispatchStreakReminders({
    subscriptions,
    queryFn,
    instant: new Date('2026-08-19T07:25:00.000Z'),
    sendNotification: async (_subscription, payload) => {
      sent.push(JSON.parse(payload))
    },
  }), 1)
  assert.match(sent[0].body, /before 12:30 AM/)
  assert.equal(sent[0].tag, 'daily-streak-2026-08-18-deadline')
})

test('PWA assets and service worker use padded Android icons and subscription recovery', async () => {
  const [manifest, serviceWorker, pushClient, profile, icon192, icon512] = await Promise.all([
    readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/push.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Profile.jsx', import.meta.url), 'utf8'),
    sharp(fileURLToPath(new URL('../public/icon-192.png', import.meta.url))).metadata(),
    sharp(fileURLToPath(new URL('../public/icon-512.png', import.meta.url))).metadata(),
  ])

  assert.match(manifest, /"src": "\/icon-512\.png"/)
  assert.match(manifest, /"src": "\/icon-192\.png"/)
  assert.match(serviceWorker, /pushsubscriptionchange/)
  assert.match(serviceWorker, /credentials: 'include'/)
  assert.match(serviceWorker, /resolvedOptions\(\)\.timeZone/)
  assert.match(pushClient, /updateViaCache: 'none'/)
  assert.match(pushClient, /subscribeInFlight/)
  assert.match(pushClient, /export async function currentPushEndpoint/)
  assert.match(profile, /JSON\.stringify\(\{ endpoint \}\)/)
  assert.deepEqual([icon192.width, icon192.height], [192, 192])
  assert.deepEqual([icon512.width, icon512.height], [512, 512])
})
