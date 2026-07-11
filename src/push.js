import { api } from './auth.jsx'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

let swReg = null
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null
  if (swReg) return swReg
  try {
    swReg = await navigator.serviceWorker.register('/sw.js')
    return swReg
  } catch {
    return null
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// Base64url form of the key an existing subscription was created with, so we
// can tell when the server's VAPID key has changed underneath us.
function keyOf(sub) {
  const buf = sub?.options?.applicationServerKey
  if (!buf) return null
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Subscribe this device for background push. Returns true on success.
export async function subscribePush() {
  if (!pushSupported()) return false
  if (Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return false
  }
  const reg = await registerSW()
  if (!reg) return false
  const { key } = await api('/api/push/key').catch(() => ({ key: '' }))
  if (!key) return false
  const wantKey = key.replace(/=+$/, '')
  let sub = await reg.pushManager.getSubscription()
  // A subscription is bound to the VAPID key it was created with. If the
  // server key has since changed, the old subscription is dead (sends fail
  // with 403), so drop it and make a fresh one with the current key.
  if (sub && keyOf(sub) && keyOf(sub) !== wantKey) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub, tz }),
  })
  return true
}

// Force a clean re-subscribe: drop any existing subscription (locally and on
// the server) and create a fresh one. Use this when notifications are stuck.
export async function reregisterPush() {
  if (!pushSupported()) return false
  const reg = await registerSW()
  if (reg) {
    const old = await reg.pushManager.getSubscription()
    if (old) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: old.endpoint }),
      }).catch(() => {})
      await old.unsubscribe().catch(() => {})
    }
  }
  return subscribePush()
}
