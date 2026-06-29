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
      icon: '/timer-shutter.png',
      badge: '/timer-shutter.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus()
      }
      if (clients.openWindow) return clients.openWindow('/')
    }),
  )
})
