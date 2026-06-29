import { useEffect, useRef } from 'react'
import { isScheduled, todayKey } from './lib.js'

// Notifications default ON unless a set explicitly opts out.
const notifyOn = (set) => set.notify !== false

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function ensurePermission() {
  if (!notificationsSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    const r = await Notification.requestPermission()
    return r === 'granted'
  } catch {
    return false
  }
}

function show(set, when) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const title = 'Chrona'
  const body =
    when === 'morning'
      ? `Make sure to do your “${set.name}” today to keep your streak going!`
      : `Last chance! Do your “${set.name}” before midnight!`
  try {
    new Notification(title, { body, tag: `${set.id}-${todayKey()}-${when}` })
  } catch {
    /* ignore */
  }
}

// A set needs reminding today if it's due, has notify on, and isn't done.
function dueAndPending(set) {
  return (
    notifyOn(set) &&
    isScheduled(set, new Date()) &&
    !set.completions?.[todayKey()] &&
    !set.freezes?.[todayKey()]
  )
}

// Schedule today's two reminders (12 AM and 11:30 PM) and refresh at midnight.
// Reminders fire only while the app is open; a fresh 12 AM reminder fires if the
// app is opened on a due day before completion. Returns a cleanup fn.
export function scheduleReminders(sets) {
  const timers = []
  const now = new Date()
  const fired = new Set()

  const at = (h, m) => {
    const t = new Date(now)
    t.setHours(h, m, 0, 0)
    return t.getTime()
  }
  const plan = [
    { when: 'morning', ms: at(0, 0) },
    { when: 'evening', ms: at(23, 30) },
  ]
  for (const p of plan) {
    const delay = p.ms - now.getTime()
    const run = () =>
      sets.filter(dueAndPending).forEach((s) => show(s, p.when))
    if (delay <= 0) {
      // Past time today: nudge once now (only morning, to avoid late spam).
      if (p.when === 'morning' && delay > -23.5 * 3600000) run()
    } else {
      timers.push(setTimeout(run, delay))
    }
  }
  // Re-plan after next midnight.
  const tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 30, 0)
  const reset = setTimeout(() => {
    timers.forEach(clearTimeout)
    window.dispatchEvent(new Event('chrona-replan'))
  }, tomorrow - now)
  timers.push(reset)
  return () => timers.forEach(clearTimeout)
}

export function useReminders(sets) {
  const ref = useRef(sets)
  ref.current = sets
  useEffect(() => {
    const wantsNotify = sets.some(notifyOn)
    if (wantsNotify) ensurePermission()
    let cleanup = scheduleReminders(ref.current)
    const replan = () => {
      cleanup?.()
      cleanup = scheduleReminders(ref.current)
    }
    window.addEventListener('chrona-replan', replan)
    return () => {
      cleanup?.()
      window.removeEventListener('chrona-replan', replan)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sets.map((s) => [s.id, s.notify]))])
}
