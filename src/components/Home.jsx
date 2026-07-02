import { useState, useRef } from 'react'
import Icon from './Icon.jsx'
import { playComplete } from '../sound.js'
import {
  totalSeconds,
  formatDuration,
  computeStreak,
  lastScheduledDates,
  isScheduled,
  dateKey,
  scheduleLabel,
  usedFreezes,
  normalizeSchedule,
  weeklyTarget,
  weeklyCount,
  ringColor,
  isDoneForToday,
  toggleSetCompleteToday,
  WEEKDAYS,
} from '../lib.js'

function FireStrip({ set }) {
  const days = lastScheduledDates(set, 7)
  return (
    <div className="fire-strip">
      {days.map((d) => {
        const k = dateKey(d)
        const done = Boolean(set.completions?.[k])
        const frozen = Boolean(set.freezes?.[k])
        const state = done ? 'done' : frozen ? 'frozen' : 'missed'
        return (
          <div key={k} className="fire-cell" title={`${WEEKDAYS[d.getDay()]} ${k}`}>
            <Icon
              name={frozen ? 'snowflake' : 'fire-element'}
              size={18}
              className={`fire fire-${state}`}
            />
          </div>
        )
      })}
    </div>
  )
}

function WeeklyRing({ set }) {
  const target = weeklyTarget(set)
  const done = weeklyCount(set)
  const p = Math.min(1, done / target)
  const R = 26
  const C = 2 * Math.PI * R
  return (
    <div className="weekly-ring" title={`${done} of ${target} this week`}>
      <svg viewBox="0 0 64 64">
        <circle className="ring-track" cx="32" cy="32" r={R} strokeWidth="6" fill="none" />
        <circle
          cx="32"
          cy="32"
          r={R}
          strokeWidth="6"
          fill="none"
          stroke={ringColor(p)}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - p)}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span className="weekly-ring-num">{done}/{target}</span>
    </div>
  )
}

function SetCard({ set, onOpen, onEdit, onDelete, onDuplicate, onComplete }) {
  const total = totalSeconds(set)
  const streak = computeStreak(set)
  const todayK = dateKey(new Date())
  const dueToday = isScheduled(set, new Date())
  const doneToday = isDoneForToday(set)
  const frozenToday = Boolean(set.freezes?.[todayK])
  const flameLit = !(dueToday && !doneToday && !frozenToday)
  const weekly = normalizeSchedule(set).mode === 'weekly'

  const [dx, setDx] = useState(0)
  const start = useRef(null)
  const base = useRef(0)
  const moved = useRef(false)
  const REVEAL = 56
  const onStart = (x) => {
    start.current = x
    base.current = dx
    moved.current = false
  }
  const onMove = (x) => {
    if (start.current == null) return
    if (Math.abs(x - start.current) > 6) moved.current = true
    setDx(Math.max(-REVEAL, Math.min(REVEAL, base.current + (x - start.current))))
  }
  const onEnd = () => {
    if (dx >= REVEAL - 1) {
      onComplete()
      setDx(0)
    } else if (dx > 0) {
      setDx(0)
    } else {
      setDx(dx < -REVEAL / 2 ? -REVEAL : 0)
    }
    start.current = null
  }
  const open = () => {
    if (moved.current) return
    if (dx !== 0) { setDx(0); return }
    onOpen()
  }

  const completeProgress = Math.max(0, Math.min(1, dx / REVEAL))
  const fillOpacity = Math.pow(completeProgress, 3)

  return (
    <div className={`card-wrap${set.kind === 'task' ? ' task' : ''}`}>
      <div className="card-actions">
        <button className="swipe-act" title="Edit" onClick={() => { setDx(0); onEdit() }}>
          <Icon name="edit" size={20} />
        </button>
        <button className="swipe-act" title="Duplicate" onClick={() => { setDx(0); onDuplicate() }}>
          <Icon name="copy" size={20} />
        </button>
        <button className="swipe-act danger" title="Delete" onClick={() => { setDx(0); onDelete() }}>
          <Icon name="trash" size={20} />
        </button>
      </div>
      <div className="card-complete">
        <div
          className="card-complete-fill"
          style={{
            opacity: fillOpacity,
            background: doneToday ? '#CE2029' : '#1db954',
          }}
        />
        <Icon name={doneToday ? 'close' : 'checkmark'} size={22} />
      </div>
      <div
        className="card"
        style={{ transform: `translateX(${dx}px)` }}
        onClick={open}
        onTouchStart={(e) => onStart(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={onEnd}
      >
        <div className="card-head">
          <h2 className="card-title">{set.name || 'Untitled'}</h2>
        </div>

        {set.trackStreak && (
          <div className="card-streak">
            <div className="streak-count">
              <Icon
                name="fire-element"
                size={18}
                className={`streak-flame ${flameLit ? '' : 'fire-missed'}`}
              />
              <span className="streak-num">{streak}</span>
              <span className="streak-label">{weekly ? 'week streak' : 'day streak'}</span>
            </div>
            {weekly ? <WeeklyRing set={set} /> : <FireStrip set={set} />}
          </div>
        )}

        <div className="card-meta">
          <span className="meta-tag">{formatDuration(total)}</span>
          {scheduleLabel(set) !== 'Every day' && (
            <span className="meta-tag">{scheduleLabel(set)}</span>
          )}
          <span className="meta-tag">{set.steps.length} steps</span>
          {set.trackStreak && (
            <span className="meta-tag">
              {usedFreezes(set)} {usedFreezes(set) === 1 ? 'freeze' : 'freezes'} used
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Home({ sets, onAdd, onOpen, onEdit, onDelete, onDuplicate, onUpdate }) {
  const [confirming, setConfirming] = useState(null) // set pending deletion
  const [choosing, setChoosing] = useState(false)

  const completeCard = (set) => {
    const { set: next, completed } = toggleSetCompleteToday(set)
    onUpdate(next)
    if (completed) playComplete()
  }

  const renderCard = (s) => (
    <SetCard
      key={s.id}
      set={s}
      onOpen={() => onOpen(s.id)}
      onEdit={() => onEdit(s.id)}
      onDelete={() => setConfirming(s)}
      onDuplicate={() => onDuplicate(s.id)}
      onComplete={() => completeCard(s)}
    />
  )

  const todo = []
  const done = []
  for (const s of sets) {
    const dueToday = isScheduled(s, new Date())
    const isDone = isDoneForToday(s)
    const frozen = Boolean(s.freezes?.[dateKey(new Date())])
    if (dueToday && !isDone && !frozen) todo.push(s)
    else done.push(s)
  }

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h1 className="page-title">Your Streaks</h1>
        </div>
        {sets.length > 0 && (
          <button
            className="add-circle-btn"
            onClick={() => setChoosing(true)}
            title="New set"
            aria-label="New set"
          >
            <Icon name="add-circle" size={44} />
          </button>
        )}
      </div>

      {sets.length === 0 ? (
        <div className="empty">
          <Icon name="timer" size={56} />
          <p>No sets yet.</p>
          <button
            className="add-circle-btn"
            onClick={() => setChoosing(true)}
            title="Create your first set"
            aria-label="Create your first set"
          >
            <Icon name="add-circle" size={44} />
          </button>
        </div>
      ) : (
        <>
          {todo.length > 0 && (
            <section className="home-section">
              <h2 className="section-title">To do today</h2>
              <div className="card-grid">{todo.map(renderCard)}</div>
            </section>
          )}
          {done.length > 0 && (
            <section className="home-section">
              <h2 className="section-title">Completed for now</h2>
              <div className="card-grid">{done.map(renderCard)}</div>
            </section>
          )}
        </>
      )}

      {choosing && (
        <div className="modal-overlay" onClick={() => setChoosing(false)}>
          <div className="modal chooser-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">New set</h3>
            <p className="modal-body">Pick what kind of set you’d like to create.</p>
            <div className="chooser-row">
              <button
                className="chooser-btn timer"
                onClick={() => { setChoosing(false); onAdd('timer') }}
              >
                <Icon name="timer-2" size={40} />
                <span>Timer</span>
              </button>
              <button
                className="chooser-btn task"
                onClick={() => { setChoosing(false); onAdd('task') }}
              >
                <Icon name="task" size={40} />
                <span>Task</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div className="modal-overlay" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete set?</h3>
            <p className="modal-body">
              “{confirming.name}” and its streak history will be permanently
              removed. This can’t be undone.
            </p>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                className="danger-btn"
                onClick={() => {
                  onDelete(confirming.id)
                  setConfirming(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
