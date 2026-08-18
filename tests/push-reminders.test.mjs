import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { reminderPlan } from '../src/notify.js'
import {
  dispatchStreakReminders,
  streakReminderDate,
  streakReminderPhase,
} from '../server/push.js'

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
