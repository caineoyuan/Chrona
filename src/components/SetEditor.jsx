import { useState, useRef, useEffect } from 'react'
import { uid } from '../storage.js'
import Icon from './Icon.jsx'
import {
  totalSeconds,
  formatDuration,
  WEEKDAYS,
  normalizeSchedule,
  scheduleLabel,
} from '../lib.js'

const BREAK_PRESETS = [5, 10, 30]

const FREQ_OPTIONS = [
  { freq: 'weekly', interval: 1, everyDay: true, label: 'Every day' },
  { freq: 'weekly', interval: 1, label: 'Every week' },
  { freq: 'weekly', interval: 2, label: 'Every 2 weeks' },
  { freq: 'weekly', interval: 3, label: 'Every 3 weeks' },
  { freq: 'weekly', interval: 4, label: 'Every 4 weeks' },
  { freq: 'monthly', interval: 1, label: 'Every month' },
  { freq: 'yearly', interval: 1, label: 'Every year' },
]

const digitsOnly = (v) => v.replace(/\D/g, '').slice(0, 2)

function StepRow({
  step,
  index,
  onChange,
  onRemove,
  onMove,
  onCreateNew,
  autoFocus,
  isFirst,
  isLast,
}) {
  const total = Number(step.seconds) || 0
  const [mins, setMins] = useState(() =>
    String(Math.floor(total / 60)).padStart(2, '0'),
  )
  const [secs, setSecs] = useState(() => String(total % 60).padStart(2, '0'))
  const titleRef = useRef(null)
  const minRef = useRef(null)
  const secRef = useRef(null)

  useEffect(() => {
    if (!autoFocus) return
    const el = titleRef.current || minRef.current
    if (el) {
      el.focus()
      el.select?.()
    }
  }, [autoFocus])

  const commit = (m, s) => {
    const next = Math.max(
      0,
      (parseInt(m, 10) || 0) * 60 + Math.min(59, parseInt(s, 10) || 0),
    )
    onChange({ ...step, seconds: next })
  }

  const focusSecs = () => {
    if (secRef.current) {
      secRef.current.focus()
      secRef.current.select()
    }
  }

  const onTitleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      minRef.current?.focus()
      minRef.current?.select()
    }
  }

  const onMinsChange = (e) => {
    const d = digitsOnly(e.target.value)
    setMins(d)
    commit(d, secs)
    // two digits entered -> jump to the seconds field (tens first)
    if (d.length === 2) focusSecs()
  }

  const onMinsKeyDown = (e) => {
    if (e.key === ' ' || e.key === ':' || e.key === 'Enter') {
      e.preventDefault()
      focusSecs()
    }
  }

  const onSecsChange = (e) => {
    const d = digitsOnly(e.target.value)
    setSecs(d)
    commit(mins, d)
  }

  const onSecsKeyDown = (e) => {
    const el = e.currentTarget
    if (e.key === 'Enter') {
      e.preventDefault()
      el.blur()
      onCreateNew?.()
      return
    }
    if (
      e.key === 'Backspace' &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0
    ) {
      e.preventDefault()
      const m = minRef.current
      if (m) {
        m.focus()
        m.setSelectionRange(m.value.length, m.value.length)
      }
    }
  }

  const padBlur = (setter) => (e) => {
    const n = parseInt(digitsOnly(e.target.value), 10) || 0
    setter(String(n).padStart(2, '0'))
  }

  const toggleNoTime = () => {
    if (step.noTime) {
      setMins('01')
      setSecs('00')
      onChange({ ...step, noTime: false, seconds: 60 })
    } else {
      onChange({ ...step, noTime: true, seconds: 0 })
    }
  }

  return (
    <div className={`step-row step-${step.type}`}>
      <div className="step-index">{index + 1}</div>
      <div className="step-main">
        {step.type === 'exercise' ? (
          <input
            ref={titleRef}
            className="step-name-input"
            value={step.name}
            placeholder="Exercise name"
            onChange={(e) => onChange({ ...step, name: e.target.value })}
            onKeyDown={onTitleKeyDown}
          />
        ) : (
          <span className="step-break-label">
            <Icon name="coffee" size={18} /> Break
          </span>
        )}
        <div className="time-fields">
          {step.noTime ? (
            <span className="no-time-label" />
          ) : (
            <>
              <input
                ref={minRef}
                className="time-seg"
                type="text"
                inputMode="numeric"
                value={mins}
                onChange={onMinsChange}
                onKeyDown={onMinsKeyDown}
                onFocus={(e) => e.target.select()}
                onBlur={padBlur((v) => {
                  setMins(v)
                  commit(v, secs)
                })}
                aria-label="minutes"
              />
              <span className="time-colon">:</span>
              <input
                ref={secRef}
                className="time-seg"
                type="text"
                inputMode="numeric"
                value={secs}
                onChange={onSecsChange}
                onKeyDown={onSecsKeyDown}
                onFocus={(e) => e.target.select()}
                onBlur={padBlur((v) => {
                  const clamped = String(Math.min(59, parseInt(v, 10) || 0)).padStart(2, '0')
                  setSecs(clamped)
                  commit(mins, clamped)
                })}
                aria-label="seconds"
              />
            </>
          )}
        </div>
      </div>
      <div className="step-actions">
        <button className="icon-btn" disabled={isFirst} onClick={() => onMove(-1)} title="Move up">
          <Icon name="up" size={16} />
        </button>
        <button className="icon-btn" disabled={isLast} onClick={() => onMove(1)} title="Move down">
          <Icon name="down" size={16} />
        </button>
        <button className="icon-btn danger" onClick={onRemove} title="Remove">
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  )
}

export default function SetEditor({ set, onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(() => ({
    ...set,
    steps: set.steps.map((s) => ({ ...s })),
    schedule: normalizeSchedule(set),
  }))
  const [focusId, setFocusId] = useState(null)
  const [showHelp, setShowHelp] = useState(false)
  const nameRef = useRef(null)
  const [dragX, setDragX] = useState(0)
  const swipe = useRef(null)
  const onSwipeStart = (e) => {
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, ok: false }
  }
  const onSwipeMove = (e) => {
    if (!swipe.current) return
    const dx = e.touches[0].clientX - swipe.current.x
    const dy = e.touches[0].clientY - swipe.current.y
    if (!swipe.current.ok) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      swipe.current.ok = Math.abs(dx) > Math.abs(dy) // horizontal intent
      if (!swipe.current.ok) { swipe.current = null; return }
    }
    setDragX(Math.max(0, dx))
  }
  const onSwipeEnd = () => {
    if (!swipe.current) return
    swipe.current = null
    if (dragX > window.innerWidth * 0.4) onCancel()
    else setDragX(0)
  }
  useEffect(() => {
    if (!set.name) nameRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const updateSchedule = (patch) =>
    setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }))

  const isTask = set.kind === 'task'

  const addExercise = () => {
    const step = isTask
      ? { id: uid(), type: 'exercise', name: '', seconds: 0, noTime: true }
      : { id: uid(), type: 'exercise', name: '', seconds: 60 }
    update({ steps: [...draft.steps, step] })
    setFocusId(step.id)
  }

  const addBreak = (seconds) => {
    const step = { id: uid(), type: 'break', name: 'Break', seconds }
    update({ steps: [...draft.steps, step] })
    setFocusId(step.id)
  }

  const changeStep = (i, next) =>
    update({ steps: draft.steps.map((s, idx) => (idx === i ? next : s)) })

  const removeStep = (i) =>
    update({ steps: draft.steps.filter((_, idx) => idx !== i) })

  const moveStep = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= draft.steps.length) return
    const next = [...draft.steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    update({ steps: next })
  }

  const toggleDay = (day) => {
    const days = draft.schedule.days || []
    updateSchedule({
      days: days.includes(day)
        ? days.filter((d) => d !== day)
        : [...days, day],
    })
  }

  const setFrequency = (freq, interval) => updateSchedule({ freq, interval })
  const setDayOfMonth = (dom) => updateSchedule({ dayOfMonth: dom })

  const sc = draft.schedule
  const dayCount = (sc.days || []).length
  const isEveryDay =
    sc.freq === 'weekly' && sc.interval === 1 && (dayCount === 0 || dayCount === 7)
  const total = totalSeconds(draft)

  return (
    <div
      className={`editor${set.kind === 'task' ? ' task' : ''}`}
      style={{ transform: dragX ? `translateX(${dragX}px)` : undefined, transition: dragX ? 'none' : 'transform 0.2s ease' }}
      onTouchStart={onSwipeStart}
      onTouchMove={onSwipeMove}
      onTouchEnd={onSwipeEnd}
    >
      <div className="editor-head">
        <button
          className="icon-btn"
          onClick={onCancel}
          title="Back"
          aria-label="Back"
        >
          <Icon name="arrow-left" size={22} />
        </button>
        <button
          className="icon-btn save-icon-btn"
          onClick={() => onSave(draft)}
          title="Save set"
          aria-label="Save set"
        >
          <Icon name="save" size={20} />
        </button>
      </div>

      <input
        ref={nameRef}
        className="set-name-input"
        value={draft.name}
        placeholder="Set Name"
        onChange={(e) => update({ name: e.target.value })}
      />
      <p className="editor-total">Total time: {formatDuration(total)}</p>

      <section className="editor-section">
        <div className="steps-head">
          <h3 className="section-title">Steps</h3>
          <button
            className={`help-toggle ${showHelp ? 'open' : ''}`}
            onClick={() => setShowHelp((v) => !v)}
            title={showHelp ? 'Hide time entry help' : 'How to enter times'}
            aria-label="Toggle time entry help"
            aria-expanded={showHelp}
          >
            <Icon name="chevron-up" size={18} />
          </button>
        </div>
        {showHelp && (
          <p className="muted small syntax-help">
            Time is <strong>MM&nbsp;:&nbsp;SS</strong>. Enter the title and press{' '}
            <kbd>Enter</kbd> to jump to the time; type the minutes (tens first),
            then the seconds. Press <kbd>Enter</kbd> on the time to add another
            step. Seconds cap at 59.
          </p>
        )}
        {draft.steps.length === 0 && (
          <p className="muted">No steps yet</p>
        )}
        <div className="step-list">
          {draft.steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              index={i}
              isFirst={i === 0}
              isLast={i === draft.steps.length - 1}
              autoFocus={step.id === focusId}
              onChange={(next) => changeStep(i, next)}
              onRemove={() => removeStep(i)}
              onMove={(dir) => moveStep(i, dir)}
              onCreateNew={addExercise}
            />
          ))}
        </div>

        <div className="add-row">
          <button className="add-btn with-icon" onClick={addExercise}>
            <Icon name="plus-math" size={15} className="add-plus" />{' '}
            {isTask ? 'Task' : 'Timer'}
          </button>
          {!isTask && (
            <div className="break-presets">
              <span className="muted small">Break:</span>
              {BREAK_PRESETS.map((p) => (
                <button
                  key={p}
                  className="circle-btn break-circle"
                  onClick={() => addBreak(p)}
                  title={`${p} second break`}
                >
                  {p}s
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {!isTask && (
      <section className="editor-section">
        <label className="toggle-row">
          <span>
            <strong>Loop continuously</strong>
            <br />
            <span className="muted small">
              Restart from the first step automatically until you stop.
            </span>
          </span>
          <input
            type="checkbox"
            className="switch-input"
            checked={Boolean(draft.loop)}
            onChange={(e) => update({ loop: e.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
        </label>
      </section>
      )}

      <section className="editor-section">
        <label className="toggle-row">
          <span>
            <strong>Keep track of streaks</strong>
            <br />
            <span className="muted small">
              Count consecutive scheduled days you complete this set.
            </span>
          </span>
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.trackStreak}
            onChange={(e) => update({ trackStreak: e.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
        </label>
      </section>

      {draft.trackStreak && (
      <section className="editor-section">
        <h3 className="section-title">Schedule streaks</h3>
        <div className="freq-picker">
          <button
            className={`freq-btn ${sc.mode !== 'weekly' ? 'active' : ''}`}
            onClick={() => updateSchedule({ mode: 'days' })}
          >
            Scheduled days
          </button>
          <button
            className={`freq-btn ${sc.mode === 'weekly' ? 'active' : ''}`}
            onClick={() => updateSchedule({ mode: 'weekly' })}
          >
            # of Days a Week
          </button>
        </div>

        {sc.mode === 'weekly' ? (
          <>
            <p className="muted small">
              Do this set a target number of days each week. Counts reset
              Sunday; the week is judged Saturday 11:59 PM.
            </p>
            <div className="month-grid">
              {Array.from({ length: 7 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={`circle-btn dom-circle ${
                    (sc.timesPerWeek || 3) === n ? 'active' : ''
                  }`}
                  onClick={() => updateSchedule({ timesPerWeek: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
        <div className="freq-picker">
          {FREQ_OPTIONS.map((opt) => {
            const active = opt.everyDay
              ? isEveryDay
              : opt.freq === 'weekly' && opt.interval === 1
                ? sc.freq === 'weekly' && sc.interval === 1 && !isEveryDay
                : sc.freq === opt.freq && sc.interval === opt.interval
            const onClick = () => {
              if (opt.everyDay) {
                updateSchedule({ freq: 'weekly', interval: 1, days: [] })
              } else if (opt.freq === 'weekly' && opt.interval === 1) {
                const cur = sc.days || []
                const days = cur.length > 0 && cur.length < 7 ? cur : [new Date().getDay()]
                updateSchedule({ freq: 'weekly', interval: 1, days })
              } else {
                setFrequency(opt.freq, opt.interval)
              }
            }
            return (
              <button
                key={opt.label}
                className={`freq-btn ${active ? 'active' : ''}`}
                onClick={onClick}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        {sc.freq === 'weekly' && !isEveryDay && (
          <>
            <p className="muted small">Pick the weekdays it repeats on.</p>
            <div className="day-picker">
              {WEEKDAYS.map((label, day) => (
                <button
                  key={day}
                  className={`circle-btn day-circle ${
                    (sc.days || []).includes(day) ? 'active' : ''
                  }`}
                  onClick={() => toggleDay(day)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {sc.freq === 'monthly' && (
          <>
            <p className="muted small">
              Pick the day of the month. 29–31 fall on the last day of shorter
              months.
            </p>
            <div className="month-grid">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((dom) => (
                <button
                  key={dom}
                  className={`circle-btn dom-circle ${
                    sc.dayOfMonth === dom ? 'active' : ''
                  }`}
                  onClick={() => setDayOfMonth(dom)}
                >
                  {dom}
                </button>
              ))}
            </div>
          </>
        )}

        {sc.freq === 'yearly' && (
          <p className="muted small">
            Repeats {scheduleLabel({ ...draft }).toLowerCase()}.
          </p>
        )}
          </>
        )}
      </section>
      )}

      <section className="editor-section save-delete-row">
        <button
          className="round-action save-round"
          onClick={() => onSave(draft)}
          title="Save set"
          aria-label="Save set"
        >
          <Icon name="save" size={24} />
        </button>
      </section>
    </div>
  )
}
