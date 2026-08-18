// Chrona service worker — Web Push + notification clicks.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = { title: 'Chrona', body: 'Your set is due today.' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Chrona', {
      body: data.body,
      tag: data.tag,
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const response = await fetch('/api/push/key', { credentials: 'include' })
    if (!response.ok) throw new Error('Could not refresh push key.')
    const { key } = await response.json()
    const padding = '='.repeat((4 - key.length % 4) % 4)
    const raw = atob((key + padding).replace(/-/g, '+').replace(/_/g, '/'))
    const applicationServerKey = Uint8Array.from(raw, (character) => character.charCodeAt(0))
    const subscription = event.newSubscription || await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    })
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const result = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, tz }),
    })
    if (!result.ok) throw new Error('Could not refresh push subscription.')
  })())
})

self.addEventListener('notificationclick', (event) => {
  const url = event.notification.data?.url || '/'
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('navigate' in c) {
          return c.navigate(url).then((client) => client?.focus())
        }
        if ('focus' in c) return c.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    }),
  )
})
