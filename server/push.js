import { Router } from 'express'
import webpush from 'web-push'
import cron from 'node-cron'
import { query } from './db.js'
import { requireAuth } from './auth.js'
import { isScheduled, dateKey } from '../src/lib.js'

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
    const { subscription, tz } = req.body || {}
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Bad subscription' })
    await query(
      `INSERT INTO push_subscriptions (endpoint, user_id, subscription, tz)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint)
       DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, tz = EXCLUDED.tz`,
      [subscription.endpoint, req.userId, JSON.stringify(subscription), tz || 'UTC'],
    )
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
    const subs = (
      await query('SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = $1', [req.userId])
    ).rows
    if (!subs.length) return res.status(404).json({ error: 'No devices subscribed yet. Turn on a bell first.' })
    const payload = JSON.stringify({
      title: 'Chrona',
      body: 'Test reminder — notifications are working! 🔥',
      tag: `test-${Date.now()}`,
    })
    await Promise.all(
      subs.map((s) =>
        webpush.sendNotification(asObj(s.subscription), payload).catch(async (err) => {
          if (err?.statusCode === 404 || err?.statusCode === 410)
            await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]).catch(() => {})
        }),
      ),
    )
    res.json({ ok: true, sent: subs.length })
  } catch (err) {
    console.error('test push error', err)
    res.status(500).json({ error: `Could not send test: ${err?.statusCode || ''} ${err?.body || err?.message || ''}`.trim() })
  }
})

// What time is it (HH:MM) in a given IANA timezone right now?
function tzNow(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const g = (t) => p.find((x) => x.type === t)?.value
    return { y: +g('year'), m: +g('month'), d: +g('day'), hh: g('hour'), mm: g('minute') }
  } catch {
    return null
  }
}

const notifyOn = (s) => s.notify !== false

function dueAndPending(set, localDate) {
  if (!notifyOn(set)) return false
  if (!isScheduled(set, localDate)) return false
  const k = dateKey(localDate)
  return !set.completions?.[k] && !set.freezes?.[k]
}

async function send(sub, set, when) {
  const body = when === 'morning'
    ? `Make sure to do your “${set.name}” today to keep your streak going!`
    : `Last chance! Do your “${set.name}” before midnight!`
  try {
    await webpush.sendNotification(
      asObj(sub.subscription),
      JSON.stringify({ title: 'Chrona', body, tag: `${set.id}-${dateKey(new Date())}-${when}` }),
    )
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]).catch(() => {})
    }
  }
}

async function tick() {
  if (!configured) return
  const subs = (await query('SELECT endpoint, user_id, subscription, tz FROM push_subscriptions')).rows
  for (const sub of subs) {
    const now = tzNow(sub.tz)
    if (!now) continue
    const when = now.hh === '00' && now.mm === '00' ? 'morning'
      : now.hh === '23' && now.mm === '30' ? 'evening' : null
    if (!when) continue
    const localDate = new Date(now.y, now.m - 1, now.d, 12, 0, 0)
    const r = await query('SELECT sets FROM user_sets WHERE user_id = $1', [sub.user_id])
    const sets = Array.isArray(r.rows[0]?.sets) ? r.rows[0].sets : []
    for (const set of sets) if (dueAndPending(set, localDate)) await send(sub, set, when)
  }
}

export function startPushCron() {
  if (!configured) return
  cron.schedule('* * * * *', () => tick().catch((e) => console.error('push tick', e)))
}

export default router
