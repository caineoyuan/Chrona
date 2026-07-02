import { useEffect, useRef, useState } from 'react'
import { useSets, newSet, uid } from './storage.js'
import { todayKey } from './lib.js'
import { useReminders } from './notify.js'
import { subscribePush } from './push.js'
import { useAuth } from './auth.jsx'
import Icon from './components/Icon.jsx'
import Home from './components/Home.jsx'
import SetEditor from './components/SetEditor.jsx'
import RunView from './components/RunView.jsx'
import Login from './components/Login.jsx'
import Profile from './components/Profile.jsx'

// Re-render at local midnight (and on refocus) so date-based values stay fresh.
function useDayKey() {
  const [day, setDay] = useState(todayKey())
  useEffect(() => {
    let timer
    const schedule = () => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(24, 0, 0, 0) // next local midnight
      timer = setTimeout(() => {
        setDay(todayKey())
        schedule()
      }, next - now + 50)
    }
    const refresh = () => {
      if (document.visibilityState === 'visible') setDay(todayKey())
    }
    schedule()
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return day
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="app auth-loading">
        <Icon name="timer" size={44} className="brand-mark spin-soft" />
      </div>
    )
  }

  if (!user) return <Login />

  return <Workspace />
}

function Workspace() {
  const [sets, setSets, loaded] = useSets()
  // Re-render the whole tree at local midnight (and on refocus) so date-based
  // values — streaks, today's completion, freezable date — never go stale.
  useDayKey()
  useReminders(sets)
  // If any set wants reminders and permission is already granted, refresh the
  // device's push subscription so background notifications keep working.
  useEffect(() => {
    if (loaded && sets.some((s) => s.notify !== false) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      subscribePush().catch(() => {})
    }
  }, [loaded, sets])
  const [profileOpen, setProfileOpen] = useState(false)
  // view: { name: 'home' } | { name: 'edit', id } | { name: 'run', id }
  const [view, setView] = useState({ name: 'home' })
  const [dir, setDir] = useState('forward')

  const go = (next, direction = 'forward') => {
    setDir(direction)
    setView(next)
  }

  const fromPop = useRef(false)
  const didInit = useRef(false)
  useEffect(() => {
    window.history.replaceState({ view: { name: 'home' }, profileOpen: false }, '')
    const onPop = (e) => {
      const st = e.state || { view: { name: 'home' }, profileOpen: false }
      fromPop.current = true
      setDir('back')
      setView(st.view || { name: 'home' })
      setProfileOpen(!!st.profileOpen)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (fromPop.current) {
      fromPop.current = false
      return
    }
    if (!didInit.current) {
      didInit.current = true
      return
    }
    window.history.pushState({ view, profileOpen }, '')
  }, [view, profileOpen])

  const upsertSet = (set) =>
    setSets((prev) => {
      const exists = prev.some((s) => s.id === set.id)
      return exists
        ? prev.map((s) => (s.id === set.id ? set : s))
        : [...prev, set]
    })

  const deleteSet = (id) => setSets((prev) => prev.filter((s) => s.id !== id))

  const duplicateSet = (id) =>
    setSets((prev) => {
      const src = prev.find((s) => s.id === id)
      if (!src) return prev
      const copy = {
        ...src,
        id: uid(),
        name: `${src.name} (Copy)`,
        steps: src.steps.map((step) => ({ ...step, id: uid() })),
        schedule:
          src.schedule && typeof src.schedule === 'object' && !Array.isArray(src.schedule)
            ? { ...src.schedule }
            : src.schedule,
        completions: {},
        freezes: {},
        createdAt: new Date().toISOString(),
      }
      const i = prev.findIndex((s) => s.id === id)
      const next = [...prev]
      next.splice(i + 1, 0, copy)
      return next
    })

  const current = sets.find((s) => s.id === view.id)

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go({ name: 'home' }, 'back')}>
          <Icon name="timer" size={26} className="brand-mark" />
          <span className="brand-name">Chrona</span>
        </button>
        <button
          className="icon-btn profile-btn"
          onClick={() => setProfileOpen(true)}
          title="Profile"
          aria-label="Profile"
        >
          <Icon name="profile" size={28} />
        </button>
      </header>

      {profileOpen && <Profile onClose={() => setProfileOpen(false)} />}

      <main className="content">
        <div className={`view-anim ${dir}`} key={`${view.name}-${view.id || ''}`}>
        {view.name === 'home' && (
          <Home
            sets={sets}
            loading={!loaded}
            onAdd={(kind) => {
              const s = newSet(kind)
              upsertSet(s)
              go({ name: 'edit', id: s.id }, 'forward')
            }}
            onOpen={(id) => go({ name: 'run', id }, 'forward')}
            onEdit={(id) => go({ name: 'edit', id }, 'forward')}
            onDelete={(id) => deleteSet(id)}
            onDuplicate={(id) => duplicateSet(id)}
            onUpdate={upsertSet}
          />
        )}

        {view.name === 'edit' && current && (
          <SetEditor
            set={current}
            onSave={(s) => {
              upsertSet(s)
              go({ name: 'home' }, 'back')
            }}
            onDelete={() => {
              deleteSet(current.id)
              go({ name: 'home' }, 'back')
            }}
            onCancel={() =>
              go(
                view.from === 'run' ? { name: 'run', id: current.id } : { name: 'home' },
                'back',
              )
            }
          />
        )}

        {view.name === 'run' && current && (
          <RunView
            set={current}
            onUpdate={upsertSet}
            onEdit={() => go({ name: 'edit', id: current.id, from: 'run' }, 'forward')}
            onBack={() => go({ name: 'home' }, 'back')}
          />
        )}
        </div>
      </main>

      <footer className="app-footer">
        <a
          href="https://www.flaticon.com/free-icons/camera"
          target="_blank"
          rel="noopener noreferrer"
          title="shutter icons created by Flaticon"
        >
          Shutter icon by Flaticon
        </a>
      </footer>
    </div>
  )
}
