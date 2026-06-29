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
  let sub = await reg.pushManager.getSubscription()
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
