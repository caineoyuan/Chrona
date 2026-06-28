import { useState } from 'react'
import Icon from './Icon.jsx'
import {
  totalSeconds,
  formatDuration,
  computeStreak,
  lastScheduledDates,
  isScheduled,
  dateKey,
  scheduleLabel,
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

function SetCard({ set, onOpen, onEdit, onDelete, onDuplicate }) {
  const total = totalSeconds(set)
  const streak = computeStreak(set)
  const todayK = dateKey(new Date())
  const dueToday = isScheduled(set, new Date())
  const doneToday = Boolean(set.completions?.[todayK])
  const frozenToday = Boolean(set.freezes?.[todayK])
  const flameLit = !(dueToday && !doneToday && !frozenToday)
  return (
    <div className="card" onClick={onOpen}>
      <div className="card-head">
        <h2 className="card-title">{set.name}</h2>
        <div className="card-head-actions">
          <button
            className="icon-btn"
            title="Edit set"
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
          >
            <Icon name="edit" size={20} />
          </button>
          <button
            className="icon-btn"
            title="Duplicate set"
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate()
            }}
          >
            <Icon name="copy" size={20} />
          </button>
          <button
            className="icon-btn danger"
            title="Delete set"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Icon name="trash" size={20} />
          </button>
        </div>
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
            <span className="streak-label">day streak</span>
          </div>
          <FireStrip set={set} />
        </div>
      )}

      <div className="card-meta">
        <span className="meta-tag">{formatDuration(total)}</span>
        {scheduleLabel(set) !== 'Every day' && (
          <span className="meta-tag">{scheduleLabel(set)}</span>
        )}
        <span className="meta-tag">{set.steps.length} steps</span>
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
