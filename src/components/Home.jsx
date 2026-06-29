import { useState, useRef } from 'react'
import Icon from './Icon.jsx'
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

function SetCard({ set, onOpen, onEdit, onDelete, onDuplicate }) {
  const total = totalSeconds(set)
  const streak = computeStreak(set)
  const todayK = dateKey(new Date())
  const dueToday = isScheduled(set, new Date())
  const doneToday = Boolean(set.completions?.[todayK])
  const frozenToday = Boolean(set.freezes?.[todayK])
  const flameLit = !(dueToday && !doneToday && !frozenToday)
  const weekly = normalizeSchedule(set).mode === 'weekly'

  const [dx, setDx] = useState(0)
  const start = useRef(null)
  const base = useRef(0)
  const moved = useRef(false)
  const REVEAL = 132
  const onStart = (x) => {
    start.current = x
    base.current = dx
    moved.current = false
  }
  const onMove = (x) => {
    if (start.current == null) return
    if (Math.abs(x - start.current) > 6) moved.current = true
    setDx(Math.max(-REVEAL, Math.min(0, base.current + (x - start.current))))
  }
  const onEnd = () => {
    setDx((d) => (d < -REVEAL / 2 ? -REVEAL : 0))
    start.current = null
  }
  const open = () => {
    if (moved.current) return
    if (dx !== 0) { setDx(0); return }
    onOpen()
  }

  return (
    <div className="card-wrap">
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
      <div
        className="card"
        style={{ transform: `translateX(${dx}px)` }}
        onClick={open}
        onTouchStart={(e) => onStart(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={onEnd}
      >
        <div className="card-head">
          <h2 className="card-title">{set.name}</h2>
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

export default function Home({ sets, onAdd, onOpen, onEdit, onDelete, onDuplicate }) {
  const [confirming, setConfirming] = useState(null) // set pending deletion

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h1 className="page-title">Your Sets</h1>
        </div>
        {sets.length > 0 && (
          <button
            className="add-circle-btn"
            onClick={onAdd}
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
            onClick={onAdd}
            title="Create your first set"
            aria-label="Create your first set"
          >
            <Icon name="add-circle" size={44} />
          </button>
        </div>
      ) : (
        <div className="card-grid">
          {sets.map((s) => (
            <SetCard
              key={s.id}
              set={s}
              onOpen={() => onOpen(s.id)}
              onEdit={() => onEdit(s.id)}
              onDelete={() => setConfirming(s)}
              onDuplicate={() => onDuplicate(s.id)}
            />
          ))}
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
