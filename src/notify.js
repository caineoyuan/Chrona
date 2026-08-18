import { useEffect, useRef } from 'react'
import { isScheduled, streakDate, todayKey } from './lib.js'

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

async function show(set, when) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const title = 'Chrona'
  const body =
    when === 'morning'
      ? `Make sure to do your “${set.name}” today to keep your streak going!`
      : `Last chance! Do your “${set.name}” before 12:30 AM!`
  try {
    const options = {
      body,
      tag: `${set.id}-${todayKey()}-${when}`,
      icon: '/icon-192.png',
    }
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) await registration.showNotification(title, options)
    else new Notification(title, options)
  } catch {
    /* ignore */
  }
}

// A set needs reminding today if it's due, has notify on, and isn't done.
function dueAndPending(set) {
  return (
    notifyOn(set) &&
    isScheduled(set, streakDate()) &&
    !set.completions?.[todayKey()] &&
    !set.freezes?.[todayKey()]
  )
}

export function reminderPlan(now = new Date()) {
  const at = (h, m) => {
    const time = new Date(now)
    time.setHours(h, m, 0, 0)
    return time
  }
  const morning = at(9, 0)
  const deadline = at(0, 25)
  if (deadline < now) deadline.setDate(deadline.getDate() + 1)
  return [
    { when: 'morning', at: morning },
    { when: 'deadline', at: deadline },
  ]
}

// Schedule reminders for 9:00 AM and five minutes before the 12:30 AM deadline.
// Reminders fire only while the app is open; a fresh morning reminder fires if the
// app is opened on a due day before completion. Returns a cleanup fn.
export function scheduleReminders(sets) {
  const timers = []
  const now = new Date()

  for (const reminder of reminderPlan(now)) {
    const delay = reminder.at.getTime() - now.getTime()
    const run = () =>
      sets.filter(dueAndPending).forEach((set) => void show(set, reminder.when))
    if (delay <= 0) {
      // Past time today: nudge once now (only morning, to avoid late spam).
      if (reminder.when === 'morning' && delay > -23.5 * 3600000) run()
      else if (reminder.when === 'deadline' && delay > -60_000) run()
    } else {
      timers.push(setTimeout(run, delay))
    }
  }
  // Re-plan when the next streak day starts.
  const tomorrow = new Date(now)
  tomorrow.setHours(0, 31, 0, 0)
  if (tomorrow <= now) tomorrow.setDate(tomorrow.getDate() + 1)
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
