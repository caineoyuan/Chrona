import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from './auth.jsx'
import { buddyStreakClient } from './buddy-streak-client.js'
import { completionMapForUser, todayKey } from './lib.js'

export function buddySetForUser(streak, userId, fallback = {}) {
  const definition = streak.definition || {}
  const key = todayKey()
  const completions = completionMapForUser(streak.completions, userId)
  if (streak.optimisticCompleted === true) completions[key] = true
  if (streak.optimisticCompleted === false) delete completions[key]
  return {
    ...fallback,
    ...definition,
    id: fallback.id || `buddy-${streak.id}`,
    createdAt: definition.createdAt || streak.createdAt,
    steps: Array.isArray(definition.steps)
      ? definition.steps
      : (Array.isArray(fallback.steps) ? fallback.steps : []),
    completions,
    freezes: fallback.freezes || {},
    buddyStreakId: streak.id,
  }
}

export function useBuddyStreaks() {
  const client = useRef(buddyStreakClient(api))
  const [buddyStreaks, setBuddyStreaks] = useState([])
  const [loaded, setLoaded] = useState(isLocalPreview)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState('')

  const refetch = useCallback(async () => {
    if (isLocalPreview) return []
    const next = await client.current.list()
    setBuddyStreaks(next)
    setError(null)
    return next
  }, [])

  useEffect(() => {
    let active = true
    if (isLocalPreview) return () => { active = false }
    refetch()
      .catch((nextError) => {
        if (active) setError(nextError)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => { active = false }
  }, [refetch])

  useEffect(() => {
    if (isLocalPreview) return
    const accepted = () => refetch().catch(setError)
    window.addEventListener('chrona:invite-accepted', accepted)
    return () => window.removeEventListener('chrona:invite-accepted', accepted)
  }, [refetch])

  useEffect(() => {
    if (isLocalPreview || !('EventSource' in window)) return undefined
    const events = new EventSource('/api/buddy-streaks/events')
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data)
        if (event.change === 'completion') refetch().catch(setError)
      } catch (nextError) {
        console.error('Could not process buddy streak sync event:', nextError)
      }
    }
    return () => events.close()
  }, [refetch])

  const optimistic = useCallback(async (id, apply, work) => {
    const before = buddyStreaks.find((item) => item.id === id)
    setBuddyStreaks((items) => apply(items))
    try {
      const result = await work(before)
      if (result?.id) {
        setBuddyStreaks((items) =>
          items.map((item) => item.id === result.id ? result : item))
      }
      setError(null)
      setConflict('')
      return result
    } catch (nextError) {
      setError(nextError)
      if (nextError.status === 409) {
        setConflict('This shared streak changed elsewhere. Your pending change was not saved; the latest version is shown.')
        await refetch()
      }
      else if (before) {
        setBuddyStreaks((items) =>
          items.map((item) => item.id === id ? before : item))
      }
      throw nextError
    }
  }, [buddyStreaks, refetch])

  const update = useCallback((id, definition) => optimistic(
    id,
    (items) => items.map((item) =>
      item.id === id ? { ...item, definition } : item),
    (current) => client.current.update(id, current.version, definition),
  ), [optimistic])

  const remove = useCallback((id) => optimistic(
    id,
    (items) => items.filter((item) => item.id !== id),
    (current) => client.current.remove(id, current.version),
  ), [optimistic])

  const setCompletion = useCallback((id, completed) => optimistic(
    id,
    (items) => items.map((item) => item.id === id ? {
      ...item,
      optimisticCompleted: completed,
      completionSyncPending: true,
    } : item),
    async () => {
      await (completed
        ? client.current.complete(id)
        : client.current.undoCompletion(id))
      return client.current.get(id)
    },
  ), [optimistic])

  const setCompletionDate = useCallback((id, userId, dateKey, completed) => optimistic(
    id,
    (items) => items.map((item) => {
      if (item.id !== id) return item
      const history = (item.completions || []).filter((entry) =>
        String(entry.userId) !== String(userId) ||
        String(entry.completionDate || entry.localCompletedAt || '').slice(0, 10) !== dateKey)
      return {
        ...item,
        completions: completed ? [...history, {
          userId: String(userId),
          completionDate: dateKey,
          localCompletedAt: `${dateKey}T12:00:00.000Z`,
          source: 'manual',
        }] : history,
      }
    }),
    async () => {
      await client.current.setCompletionDate(id, dateKey, completed)
      return client.current.get(id)
    },
  ), [optimistic])

  const removeMember = useCallback((id, userId) => optimistic(
    id,
    (items) => items.map((item) => item.id === id ? {
      ...item,
      members: item.members.filter((member) => member.userId !== userId),
    } : item),
    async (current) => {
      await client.current.removeMember(id, userId, current.version)
      return client.current.get(id)
    },
  ), [optimistic])

  const leave = useCallback((id, userId) => optimistic(
    id,
    (items) => items.filter((item) => item.id !== id),
    (current) => client.current.leave(id, userId, current.version),
  ), [optimistic])

  const updateMember = useCallback((id, userId, role) => optimistic(
    id,
    (items) => items.map((item) => item.id === id ? {
      ...item,
      members: item.members.map((member) =>
        member.userId === userId ? { ...member, role } : member),
    } : item),
    (current) => client.current.updateMember(id, userId, current.version, role),
  ), [optimistic])

  const ping = useCallback((id, userId) =>
    client.current.ping(id, userId), [])

  const create = useCallback(async (definition) => {
    const created = await client.current.create(definition)
    setBuddyStreaks((items) => [created, ...items])
    return created
  }, [])

  const promote = useCallback(async (setId) => {
    const promoted = await client.current.promote(setId)
    setBuddyStreaks((items) => [
      promoted,
      ...items.filter((item) => item.id !== promoted.id),
    ])
    return promoted
  }, [])

  return {
    buddyStreaks,
    loaded,
    error,
    clearError: () => setError(null),
    conflict,
    clearConflict: () => setConflict(''),
    refetch,
    create,
    promote,
    update,
    remove,
    removeMember,
    leave,
    updateMember,
    ping,
    setCompletion,
    setCompletionDate,
  }
}
