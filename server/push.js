import { Router } from 'express'
import webpush from 'web-push'
import cron from 'node-cron'
import { query } from './db.js'
import { requireAuth } from './auth.js'
import { isScheduled, dateKey } from '../src/lib.js'
import {
  dispatchCollaborationPushes,
  queueAutomaticBuddyReminders,
} from './collaboration-notifications.js'

const PUBLIC = process.env.VAPID_PUBLIC_KEY
const PRIVATE = process.env.VAPID_PRIVATE_KEY
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:chrona@example.com'

const configured = Boolean(PUBLIC && PRIVATE)
if (configured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE)
} else {
  console.warn('[chrona] VAPID keys not set — web push disabled.')
}

const router = Router()

// pg returns JSONB columns already parsed; tolerate strings too.
const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

router.get('/key', (_req, res) => res.json({ key: PUBLIC || '' }))

router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription, tz, reminders } = req.body || {}
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Bad subscription' })
    if (Array.isArray(reminders)) {
      await query(
        `INSERT INTO push_subscriptions (endpoint, user_id, subscription, tz, reminders)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint)
         DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription,
                       tz = EXCLUDED.tz, reminders = EXCLUDED.reminders`,
        [subscription.endpoint, req.userId, JSON.stringify(subscription), tz || 'UTC', JSON.stringify(reminders.slice(0, 500))],
      )
    } else {
      await query(
        `INSERT INTO push_subscriptions (endpoint, user_id, subscription, tz)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint)
         DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, tz = EXCLUDED.tz`,
        [subscription.endpoint, req.userId, JSON.stringify(subscription), tz || 'UTC'],
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('subscribe error', err)
    res.status(500).json({ error: 'Could not save subscription.' })
  }
})

router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {}
    if (endpoint) await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
    res.json({ ok: true })
  } catch {
    res.json({ ok: true })
  }
})

router.post('/test', requireAuth, async (req, res) => {
  if (!configured) return res.status(400).json({ error: 'Push not configured on server.' })
  try {
    const endpoint = req.body?.endpoint
    const subs = (
      await query(
        `SELECT endpoint, subscription
         FROM push_subscriptions
         WHERE user_id = $1
           AND ($2::text IS NULL OR endpoint = $2)`,
        [req.userId, endpoint || null],
      )
    ).rows
    if (!subs.length) return res.status(404).json({ error: 'No devices subscribed yet. Turn on a bell first.' })
    const payload = JSON.stringify({
      title: 'Chrona',
      body: 'Test reminder — notifications are working! 🔥',
      tag: `test-${Date.now()}`,
    })
    const results = await Promise.all(subs.map(async (subscription) => {
      try {
        await webpush.sendNotification(asObj(subscription.subscription), payload, {
          TTL: 300,
          urgency: 'high',
        })
        return true
      } catch (error) {
        if ([403, 404, 410].includes(error?.statusCode)) {
          await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [subscription.endpoint]).catch(() => {})
        } else {
          console.error('test push delivery error', error)
        }
        return false
      }
    }))
    const sent = results.filter(Boolean).length
    if (!sent) return res.status(502).json({
      error: 'No test notification could be delivered. Re-register notifications and try again.',
    })
    res.json({ ok: true, sent })
  } catch (err) {
    console.error('test push error', err)
    res.status(500).json({ error: `Could not send test: ${err?.statusCode || ''} ${err?.body || err?.message || ''}`.trim() })
  }
})

// What time is it (HH:MM) in a given IANA timezone right now?
function tzNow(tz, instant = new Date()) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant)
    const g = (t) => p.find((x) => x.type === t)?.value
    return { y: +g('year'), m: +g('month'), d: +g('day'), hh: g('hour'), mm: g('minute') }
  } catch {
    return null
  }
}

const notifyOn = (s) => s.notify !== false

export function streakReminderPhase({ hh, mm }) {
  if (hh === '09' && mm === '00') return 'morning'
  if (hh === '00' && mm === '25') return 'deadline'
  return null
}

export function streakReminderDate({ y, m, d }, phase) {
  const date = new Date(y, m - 1, d, 12, 0, 0)
  if (phase === 'deadline') date.setDate(date.getDate() - 1)
  return date
}

function dueAndPending(set, localDate) {
  if (!notifyOn(set)) return false
  if (!set.trackStreak) return false
  if (!isScheduled(set, localDate)) return false
  const k = dateKey(localDate)
  return !set.completions?.[k] && !set.freezes?.[k]
}

async function sendStreakNotification({
  sub,
  set,
  when,
  localDate,
  queryFn = query,
  sendNotification = (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, options),
}) {
  const body = when === 'morning'
    ? `Make sure to do your “${set.name}” today to keep your streak going!`
    : `Last chance! Do your “${set.name}” before 12:30 AM!`
  try {
    await sendNotification(
      asObj(sub.subscription),
      JSON.stringify({
        title: 'Chrona',
        body,
        tag: `${set.id}-${dateKey(localDate)}-${when}`,
        icon: '/icon-192.png',
      }),
      { TTL: 3600, urgency: 'high' },
    )
    return true
  } catch (err) {
    if ([403, 404, 410].includes(err?.statusCode)) {
      await queryFn('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]).catch(() => {})
    } else {
      console.error('streak push delivery error', err)
    }
    return false
  }
}

export async function dispatchStreakReminders({
  subscriptions,
  queryFn = query,
  instant = new Date(),
  sendNotification,
}) {
  let sent = 0
  for (const sub of subscriptions) {
    const now = tzNow(sub.tz, instant)
    if (!now) continue
    const when = streakReminderPhase(now)
    if (!when) continue
    const localDate = streakReminderDate(now, when)
    const result = await queryFn('SELECT sets FROM user_sets WHERE user_id = $1', [sub.user_id])
    const sets = Array.isArray(result.rows[0]?.sets) ? result.rows[0].sets : []
    for (const set of sets) {
      if (!dueAndPending(set, localDate)) continue
      const delivered = await sendStreakNotification({
        sub,
        set,
        when,
        localDate,
        queryFn,
        sendNotification,
      })
      if (delivered) sent++
    }
  }
  return sent
}

async function tick() {
  try {
    await runCollaborationNotificationTick()
  } catch (error) {
    console.error('collaboration push tick', error)
  }
  if (!configured) return
  const subs = (await query('SELECT endpoint, user_id, subscription, tz, reminders FROM push_subscriptions')).rows
  for (const sub of subs) {
    const reminders = Array.isArray(sub.reminders) ? sub.reminders : []
    const remaining = []
    let subscriptionRemoved = false
    for (const reminder of reminders) {
      if (new Date(reminder.alertAt).getTime() > Date.now()) {
        remaining.push(reminder)
        continue
      }
      try {
        await webpush.sendNotification(
          asObj(sub.subscription),
          JSON.stringify({
            title: reminder.title || 'Medication reminder',
            body: reminder.body || 'A medication is scheduled.',
            tag: reminder.tag,
            icon: reminder.icon || '/medication-icon.png',
          }),
        )
      } catch (err) {
        if ([403, 404, 410].includes(err?.statusCode)) {
          await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]).catch(() => {})
          subscriptionRemoved = true
          break
        }
        remaining.push(reminder)
      }
    }
    if (subscriptionRemoved) continue
    if (remaining.length !== reminders.length) {
      await query('UPDATE push_subscriptions SET reminders = $1 WHERE endpoint = $2', [
        JSON.stringify(remaining),
        sub.endpoint,
      ])
    }
  }
  await dispatchStreakReminders({ subscriptions: subs })
}

export function startPushCron() {
  cron.schedule('* * * * *', () => tick().catch((e) => console.error('push tick', e)))
}

export async function runCollaborationNotificationTick({
  queryFn = query,
  pushEnabled = configured,
  queueReminders = queueAutomaticBuddyReminders,
  dispatchPushes = dispatchCollaborationPushes,
  sendNotification = (subscription, payload) =>
    webpush.sendNotification(asObj(subscription), payload),
} = {}) {
  await queueReminders(queryFn)
  if (!pushEnabled) return
  await dispatchPushes({ queryFn, sendNotification })
}

export default router
