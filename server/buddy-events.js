export function createBuddyEventHub() {
  const subscribers = new Map()

  return {
    subscribe(userId, send) {
      const key = String(userId)
      const userSubscribers = subscribers.get(key) || new Set()
      userSubscribers.add(send)
      subscribers.set(key, userSubscribers)
      return () => {
        userSubscribers.delete(send)
        if (!userSubscribers.size) subscribers.delete(key)
      }
    },
    publish(userIds, event, excludedUserId = null) {
      const excluded = excludedUserId == null ? null : String(excludedUserId)
      for (const userId of new Set(userIds.map(String))) {
        if (userId === excluded) continue
        for (const send of subscribers.get(userId) || []) send(event)
      }
    },
  }
}

export const buddyEventHub = createBuddyEventHub()
