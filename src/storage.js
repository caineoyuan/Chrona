import { useEffect, useRef, useState } from 'react'
import { api } from './auth.jsx'

// React hook that loads the signed-in user's sets from the server and
// persists changes back (debounced). Only mount this when authenticated.
export function useSets() {
  const [sets, setSets] = useState([])
  const [loaded, setLoaded] = useState(false)
  const loadedRef = useRef(false)
  const saveTimer = useRef(null)

  useEffect(() => {
    let active = true
    api('/api/sets')
      .then((data) => {
        if (!active) return
        setSets(Array.isArray(data?.sets) ? data.sets : [])
      })
      .catch(() => {
        /* keep empty on failure */
      })
      .finally(() => {
        if (!active) return
        loadedRef.current = true
        setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api('/api/sets', {
        method: 'PUT',
        body: JSON.stringify({ sets }),
      }).catch(() => {
        /* ignore transient save errors */
      })
    }, 400)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [sets])

  return [sets, setSets, loaded]
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export function newSet() {
  return {
    id: uid(),
    name: '',
    steps: [{ id: uid(), type: 'exercise', name: '', seconds: 60 }],
    schedule: [], // weekday numbers 0(Sun)-6(Sat); empty = every day
    trackStreak: true,
    loop: false,
    notify: true, // remind on due days (12 AM + 11:30 PM)
    completions: {}, // { 'YYYY-MM-DD': true }
    freezes: {}, // { 'YYYY-MM-DD': true }
    createdAt: new Date().toISOString(),
  }
}
