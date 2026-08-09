import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from './auth.jsx'
import { activityClient } from './activity-client.js'
import { invitationClient } from './invitations.js'

export function useActivity(enabled = true) {
  const activity = useRef(activityClient(api))
  const invitations = useRef(invitationClient(api))
  const [items, setItems] = useState([])
  const [pendingInvites, setPendingInvites] = useState([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(isLocalPreview || !enabled)

  const refresh = useCallback(async () => {
    if (isLocalPreview || !enabled) return
    try {
      const [nextItems, nextInvites] = await Promise.all([
        activity.current.list(),
        invitations.current.list(),
      ])
      setItems(nextItems)
      setPendingInvites(nextInvites)
      setError('')
    } catch (nextError) {
      setError(nextError.message)
    } finally {
      setLoaded(true)
    }
  }, [enabled])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const markRead = useCallback(async (id) => {
    setItems((current) => current.map((item) =>
      item.id === id ? { ...item, readAt: item.readAt || new Date().toISOString() } : item))
    try {
      await activity.current.read(id)
    } catch (nextError) {
      setError(nextError.message)
      await refresh()
    }
  }, [refresh])

  const markAllRead = useCallback(async () => {
    const readAt = new Date().toISOString()
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt || readAt })))
    try {
      await activity.current.readAll()
    } catch (nextError) {
      setError(nextError.message)
      await refresh()
    }
  }, [refresh])

  const accept = useCallback(async (id) => {
    try {
      await invitations.current.accept(id)
      setPendingInvites((current) => current.filter((invite) => invite.id !== id))
      setError('')
      await refresh()
    } catch (nextError) {
      setError(nextError.message)
      throw nextError
    }
  }, [refresh])

  const reject = useCallback(async (id) => {
    try {
      await invitations.current.decline(id)
      setPendingInvites((current) => current.filter((invite) => invite.id !== id))
      setError('')
      await refresh()
    } catch (nextError) {
      setError(nextError.message)
      throw nextError
    }
  }, [refresh])

  return {
    items,
    pendingInvites,
    error,
    loaded,
    unreadCount: items.filter((item) => !item.readAt).length,
    refresh,
    markRead,
    markAllRead,
    accept,
    reject,
  }
}
