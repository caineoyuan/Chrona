import { useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from './auth.jsx'

const PREVIEW_STORAGE_KEY = 'chrona-preview-sets-v1'
const PREVIEW_SEED_KEY = 'chrona-preview-seed-v1'

const PREVIEW_SETS = [
  {
    id: 'preview-timer-focus',
    name: 'Focus Session',
    kind: 'timer',
    steps: [
      { id: 'preview-focus-work', type: 'exercise', name: 'Focus', seconds: 1500 },
      { id: 'preview-focus-break', type: 'rest', name: 'Break', seconds: 300 },
    ],
    schedule: [],
    trackStreak: true,
    loop: false,
    notify: true,
  },
  {
    id: 'preview-timer-stretch',
    name: 'Morning Stretch',
    kind: 'timer',
    steps: [
      { id: 'preview-stretch-neck', type: 'exercise', name: 'Neck stretch', seconds: 30 },
      { id: 'preview-stretch-shoulders', type: 'exercise', name: 'Shoulder rolls', seconds: 45 },
      { id: 'preview-stretch-hamstrings', type: 'exercise', name: 'Hamstring stretch', seconds: 60 },
    ],
    schedule: [1, 2, 3, 4, 5],
    trackStreak: true,
    loop: false,
    notify: true,
  },
  {
    id: 'preview-timer-breathing',
    name: 'Breathing Reset',
    kind: 'timer',
    steps: [
      { id: 'preview-breathe-in', type: 'exercise', name: 'Breathe in', seconds: 4 },
      { id: 'preview-breathe-hold', type: 'rest', name: 'Hold', seconds: 7 },
      { id: 'preview-breathe-out', type: 'exercise', name: 'Breathe out', seconds: 8 },
    ],
    schedule: [],
    trackStreak: false,
    loop: true,
    notify: false,
  },
  {
    id: 'preview-task-morning',
    name: 'Morning Routine',
    kind: 'task',
    steps: [
      { id: 'preview-morning-water', type: 'exercise', name: 'Drink water', seconds: 0, noTime: true },
      { id: 'preview-morning-bed', type: 'exercise', name: 'Make the bed', seconds: 0, noTime: true },
      { id: 'preview-morning-plan', type: 'exercise', name: 'Review the day', seconds: 0, noTime: true },
    ],
    schedule: [],
    trackStreak: true,
    loop: false,
    notify: true,
  },
  {
    id: 'preview-task-planning',
    name: 'Weekly Planning',
    kind: 'task',
    steps: [
      { id: 'preview-planning-review', type: 'exercise', name: 'Review priorities', seconds: 0, noTime: true },
      { id: 'preview-planning-calendar', type: 'exercise', name: 'Update calendar', seconds: 0, noTime: true },
    ],
    schedule: [0],
    trackStreak: true,
    loop: false,
    notify: true,
  },
  {
    id: 'preview-task-evening',
    name: 'Evening Reset',
    kind: 'task',
    steps: [
      { id: 'preview-evening-tidy', type: 'exercise', name: 'Tidy workspace', seconds: 0, noTime: true },
      { id: 'preview-evening-prepare', type: 'exercise', name: 'Prepare for tomorrow', seconds: 0, noTime: true },
      { id: 'preview-evening-reflect', type: 'exercise', name: 'Write one reflection', seconds: 0, noTime: true },
    ],
    schedule: [],
    trackStreak: true,
    loop: false,
    notify: false,
  },
]

function createPreviewSets() {
  const createdAt = new Date().toISOString()
  return PREVIEW_SETS.map((set) => ({
    ...set,
    createdAt,
    completions: {},
    freezes: {},
  }))
}

function loadPreviewSets() {
  const previewSets = createPreviewSets()
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_STORAGE_KEY) || '[]')
    if (localStorage.getItem(PREVIEW_SEED_KEY)) return Array.isArray(saved) ? saved : previewSets

    const existing = Array.isArray(saved) ? saved : []
    const existingIds = new Set(existing.map((set) => set.id))
    const seeded = [...existing, ...previewSets.filter((set) => !existingIds.has(set.id))]
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(seeded))
    localStorage.setItem(PREVIEW_SEED_KEY, '1')
    return seeded
  } catch (error) {
    console.error('Could not load Chrona preview data:', error)
    return previewSets
  }
}

// React hook that loads the signed-in user's sets from the server and
// persists changes back (debounced). Only mount this when authenticated.
export function useSets() {
  const [sets, setSets] = useState(() => isLocalPreview ? loadPreviewSets() : [])
  const [loaded, setLoaded] = useState(isLocalPreview)
  const loadedRef = useRef(isLocalPreview)
  const saveTimer = useRef(null)

  useEffect(() => {
    if (isLocalPreview) return
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
    if (isLocalPreview) {
      try {
        localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(sets))
      } catch (error) {
        console.error('Could not save Chrona preview data:', error)
      }
      return
    }
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

export function newSet(kind = 'timer') {
  const task = kind === 'task'
  return {
    id: uid(),
    name: '',
    kind,
    steps: [
      task
        ? { id: uid(), type: 'exercise', name: '', seconds: 0, noTime: true }
        : { id: uid(), type: 'exercise', name: '', seconds: 60 },
    ],
    schedule: [], // weekday numbers 0(Sun)-6(Sat); empty = every day
    trackStreak: true,
    loop: false,
    notify: true, // remind on due days (12:31 AM + 11:30 PM)
    completions: {}, // { 'YYYY-MM-DD': true }
    freezes: {}, // { 'YYYY-MM-DD': true }
    createdAt: new Date().toISOString(),
  }
}
