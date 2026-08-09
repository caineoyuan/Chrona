import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useSets, newSet, uid } from './storage.js'
import { STREAK_GRACE_MINUTES, todayKey } from './lib.js'
import { useReminders } from './notify.js'
import { subscribePush } from './push.js'
import { useAuth } from './auth.jsx'
import Icon from './components/Icon.jsx'
import Home from './components/Home.jsx'
import SetEditor from './components/SetEditor.jsx'
import RunView from './components/RunView.jsx'
import Login from './components/Login.jsx'
import Profile from './components/Profile.jsx'
import Avatar from './components/Avatar.jsx'
import InvitationInbox from './components/InvitationInbox.jsx'
import { useActivity } from './activity.js'
import { sharingEnabled } from './feature-flags.js'

const MediraApp = lazy(() => import('./medira/App.jsx'))
const WORKSPACE_STORAGE_KEY = 'chrona-last-workspace'
const LEGACY_MEDIRA_WORKSPACE = 'dosewell'
const THEME_STORAGE_KEY = 'chrona-theme-preference'

function loadWorkspace() {
  try {
    const savedWorkspace = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (savedWorkspace === LEGACY_MEDIRA_WORKSPACE) {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, 'medira')
      return 'medira'
    }
    return savedWorkspace === 'medira' ? 'medira' : 'chrona'
  } catch {
    return 'chrona'
  }
}

function loadThemePreference() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return ['system', 'light', 'dark'].includes(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

function useThemePreference() {
  const [preference, setPreference] = useState(loadThemePreference)
  const [systemTheme, setSystemTheme] = useState(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const resolvedTheme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event) => setSystemTheme(event.matches ? 'dark' : 'light')
    update(media)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      resolvedTheme === 'light' ? '#f7f7f4' : '#131313',
    )
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {
      // The selected theme still applies for the current session.
    }
  }, [preference, resolvedTheme])

  return { preference, resolvedTheme, setPreference }
}

// Re-render just after the 12:30 AM grace minute ends (and on refocus).
function useDayKey() {
  const [day, setDay] = useState(todayKey())
  useEffect(() => {
    let timer
    const schedule = () => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(0, STREAK_GRACE_MINUTES + 1, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
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
  const theme = useThemePreference()

  if (loading) {
    return (
      <div className="app auth-loading">
        <Icon name="timer" size={44} className="brand-mark spin-soft" />
      </div>
    )
  }

  if (!user) return <Login />

  return <Workspace theme={theme} />
}

function Workspace({ theme }) {
  const { user } = useAuth()
  const activity = useActivity(sharingEnabled)
  const [sets, setSets, loaded] = useSets()
  const [appMode, setAppMode] = useState(loadWorkspace)
  // Re-render after the 12:30 AM streak deadline (and on refocus) so date-based
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

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, appMode)
    } catch {
      // The workspace still switches normally when storage is unavailable.
    }
  }, [appMode])

  useEffect(() => {
    document.title = appMode === 'medira' ? 'Medira' : 'Chrona'
  }, [appMode])

  const go = (next, direction = 'forward') => {
    setDir(direction)
    setView(next)
  }

  const fromPop = useRef(false)
  const didInit = useRef(false)
  useEffect(() => {
    window.history.replaceState({ view: { name: 'home' }, profileOpen: false, appMode }, '')
    const onPop = (e) => {
      const st = e.state || { view: { name: 'home' }, profileOpen: false }
      fromPop.current = true
      setDir('back')
      setView(st.view || { name: 'home' })
      setProfileOpen(!!st.profileOpen)
      setAppMode(st.appMode || 'chrona')
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
    window.history.pushState({ view, profileOpen, appMode }, '')
  }, [view, profileOpen, appMode])

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
    <div className={`app workspace-${appMode}`}>
      <header className="topbar">
        <div
          className="profile-menu"
        >
          <button
            className="profile-trigger"
            onClick={() => setProfileOpen((open) => !open)}
            title="Edit profile"
            aria-label="Edit profile"
            aria-expanded={profileOpen}
            aria-haspopup="dialog"
          >
            <Avatar user={user} size="topbar" />
          </button>
        </div>
        {profileOpen && <Profile onClose={() => setProfileOpen(false)}
          themePreference={theme.preference} onThemeChange={theme.setPreference} />}
        <button className="brand" onClick={() => { setAppMode('chrona'); go({ name: 'home' }, 'back') }}>
          <span key={appMode} className={`brand-content slide-${appMode === 'medira' ? 'left' : 'right'}`}>
            {appMode === 'medira'
              ? <img className="brand-mark workspace-brand-image" src="/medication-icon.png" alt="" aria-hidden="true" />
              : <Icon name="timer" size={26} className="brand-mark" />}
            <span className="brand-name">{appMode === 'medira' ? 'Medira' : 'Chrona'}</span>
          </span>
        </button>
        <div className="app-switcher" role="tablist" aria-label="Apps">
          <button className={`icon-btn app-switch-btn ${appMode === 'chrona' ? 'active' : ''}`}
            role="tab" aria-selected={appMode === 'chrona'} aria-label="Chrona" title="Chrona"
            onClick={() => setAppMode('chrona')}>
            <Icon name="timer" size={22} />
          </button>
          <button className={`icon-btn app-switch-btn ${appMode === 'medira' ? 'active' : ''}`}
            role="tab" aria-selected={appMode === 'medira'} aria-label="Medira" title="Medira"
            onClick={() => setAppMode('medira')}>
            <img src="/medication-icon.png" alt="" aria-hidden="true" />
          </button>
        </div>
        {sharingEnabled && <InvitationInbox activity={activity} />}
      </header>

      <main className="content">
        {appMode === 'chrona' ? (
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
        ) : (
          <Suspense fallback={<div className="workspace-loading" aria-label="Loading Medira" />}>
            <MediraApp colorScheme={theme.resolvedTheme} />
          </Suspense>
        )}
      </main>

      <footer className="app-footer">
        <a
          href={appMode === 'chrona'
            ? 'https://www.flaticon.com/free-icons/camera'
            : 'https://www.flaticon.com/free-icon/pill_3567506'}
          target="_blank"
          rel="noopener noreferrer"
          title={appMode === 'chrona' ? 'Shutter icons created by Flaticon' : 'Medication icon created by Freepik'}
        >
          {appMode === 'chrona' ? 'Shutter icon by Flaticon' : 'Medication icon by Freepik — Flaticon'}
        </a>
      </footer>
    </div>
  )
}
