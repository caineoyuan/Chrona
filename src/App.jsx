import { useState } from 'react'
import { useSets, newSet, uid } from './storage.js'
import { useAuth } from './auth.jsx'
import Icon from './components/Icon.jsx'
import Home from './components/Home.jsx'
import SetEditor from './components/SetEditor.jsx'
import RunView from './components/RunView.jsx'
import Login from './components/Login.jsx'
import Profile from './components/Profile.jsx'

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
  const [profileOpen, setProfileOpen] = useState(false)
  // view: { name: 'home' } | { name: 'edit', id } | { name: 'run', id }
  const [view, setView] = useState({ name: 'home' })
  const [dir, setDir] = useState('forward')

  const go = (next, direction = 'forward') => {
    setDir(direction)
    setView(next)
  }

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
            onAdd={() => {
              const s = newSet()
              upsertSet(s)
              go({ name: 'edit', id: s.id }, 'forward')
            }}
            onOpen={(id) => go({ name: 'run', id }, 'forward')}
            onEdit={(id) => go({ name: 'edit', id }, 'forward')}
            onDelete={(id) => deleteSet(id)}
            onDuplicate={(id) => duplicateSet(id)}
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
            onCancel={() => go({ name: 'home' }, 'back')}
          />
        )}

        {view.name === 'run' && current && (
          <RunView
            set={current}
            onUpdate={upsertSet}
            onEdit={() => go({ name: 'edit', id: current.id }, 'forward')}
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
