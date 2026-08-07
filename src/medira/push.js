import { api } from '../auth.jsx'
import {
  registerSW,
  reregisterPush as reregisterChronaPush,
  subscribePush as subscribeChronaPush,
} from '../push.js'
import { getUpcomingReminders } from './lib.js'

async function syncSchedule(medications) {
  const registration = await registerSW()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return false
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      subscription,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      reminders: getUpcomingReminders(medications),
    }),
  })
  return true
}

export async function subscribePush(medications) {
  if (!await subscribeChronaPush()) return false
  return syncSchedule(medications)
}

export async function reregisterPush(medications) {
  if (!await reregisterChronaPush()) return false
  return syncSchedule(medications)
}

export async function syncPushReminders(medications) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  return syncSchedule(medications)
}
