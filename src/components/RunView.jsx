import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import {
  clock,
  formatDuration,
  totalSeconds,
  computeStreak,
  usedFreezes,
  freezableDate,
  dateKey,
  todayKey,
} from '../lib.js'

const R = 46
const C = 2 * Math.PI * R

const OVERALL_R = 54
const OVERALL_C = 2 * Math.PI * OVERALL_R

const PlayGlyph = () => (
  <svg className="ctrl-glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5z" />
  </svg>
)
const PauseGlyph = () => (
  <svg className="ctrl-glyph" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="5" width="4.5" height="14" rx="1.2" />
    <rect x="13.5" y="5" width="4.5" height="14" rx="1.2" />
  </svg>
)
const RestartGlyph = () => (
  <svg className="ctrl-glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
  </svg>
)

// step-wise red -> orange -> yellow -> yellow-green at each quarter; green when done
function fillColor(p) {
  if (p < 0.25) return '#ef4444'
  if (p < 0.5) return '#f97316'
  if (p < 0.75) return '#facc15'
  return '#9ACD32'
}

function TimerCircle({ step, status, progress, onTap, paused }) {
  const active = status === 'active'
  const done = status === 'done'
  const p = done ? 1 : active ? progress : 0
  const color = done ? '#1DB954' : fillColor(p)
  const offset = C * (1 - p)
  const name = step.type === 'break' ? 'Break' : step.name || 'Exercise'

  // leading-edge spark position
  const angle = -90 + 360 * p
  const rad = (angle * Math.PI) / 180
  const sx = 60 + R * Math.cos(rad)
  const sy = 60 + R * Math.sin(rad)

  const tappable = active && onTap

  return (
    <div
      className={`timer-circle ${status}${tappable ? ' tappable' : ''}`}
      onClick={tappable ? onTap : undefined}
      title={tappable ? 'Tap to pause · double-tap to skip' : undefined}
    >
      <svg viewBox="0 0 120 120" className="ring-svg">
        <circle className="ring-track" cx="60" cy="60" r={R} />
        <circle
          className="ring-fill"
          cx="60"
          cy="60"
          r={R}
          stroke={color}
          strokeDasharray={C}
          strokeDashoffset={offset}
        />
        {active && p > 0.001 && p < 0.999 && (
          <g className="spark" transform={`translate(${sx} ${sy})`}>
            <circle r="4.5" className="spark-glow" fill={color} />
            <circle r="2.4" className="spark-core" />
          </g>
        )}
      </svg>
      <div className="ring-center">
        <span className="ring-name">{name}</span>
        {active ? (
          <span className="ring-time-active">{clock(step.activeRemaining)}</span>
        ) : (
          <span className="ring-time-faded">{clock(step.seconds)}</span>
        )}
      </div>
      {active && paused && (
        <span className="ring-paused" aria-hidden="true">
          <svg className="ctrl-glyph" viewBox="0 0 24 24">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5z" />
          </svg>
        </span>
      )}
      {done && <span className="ring-side-name">{name}</span>}
    </div>
  )
}

// A no-time step: a circular button the user clicks to mark complete.
function ManualCircle({ step, status, onComplete }) {
  const done = status === 'done'
  const active = status === 'active'
  const name = step.name || 'Exercise'
  return (
    <div className={`timer-circle manual ${status}`}>
      <button
        type="button"
        className="manual-ring"
        onClick={active ? onComplete : undefined}
        disabled={!active}
        title={active ? 'Tap to complete' : name}
        aria-label={active ? `Complete ${name}` : name}
      >
        <span className="manual-check">
          <Icon name="checkmark" size={done ? 30 : 64} />
        </span>
      </button>
      <div className="ring-center">
        <span className="ring-name">{name}</span>
        {!done && (
          <span className="ring-time-faded">
            {active ? 'Tap to complete' : 'No time'}
          </span>
        )}
      </div>
      {done && <span className="ring-side-name">{name}</span>}
    </div>
  )
}

export default function RunView({ set, onUpdate, onEdit, onBack }) {
  const steps = set.steps
  const [phase, setPhase] = useState('idle') // idle | running | paused | done
  const [index, setIndex] = useState(-1)
  const [progress, setProgress] = useState(0)
  const [remaining, setRemaining] = useState(0)

  const iRef = useRef(-1)
  const deadlineRef = useRef(0)
  const rafRef = useRef(0)
  const nodeRefs = useRef({})
  const tapTimer = useRef(null)

  const completedToday = Boolean(set.completions?.[todayKey()])
  const freezesUsed = usedFreezes(set)
  const freezeTarget = freezableDate(set)
  const freezeActive = freezeTarget
    ? Boolean(set.freezes?.[dateKey(freezeTarget)])
    : false

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      if (tapTimer.current) clearTimeout(tapTimer.current)
    },
    []
  )

  const markCompleteToday = () => {
    // Completing the set means today's freeze (if any) wasn't needed — release it.
    const freezes = { ...set.freezes }
    delete freezes[todayKey()]
    onUpdate({
      ...set,
      completions: { ...set.completions, [todayKey()]: true },
      freezes,
    })
  }

  const toggleCompleteToday = () => {
    const k = todayKey()
    const completions = { ...set.completions }
    const freezes = { ...set.freezes }
    if (completions[k]) {
      delete completions[k]
    } else {
      completions[k] = true
      // Completing releases an unused freeze on today's deadline.
      delete freezes[k]
    }
    onUpdate({ ...set, completions, freezes })
  }

  const finish = () => {
    cancelAnimationFrame(rafRef.current)
    iRef.current = steps.length
    setIndex(steps.length)
    setProgress(1)
    setPhase('done')
    markCompleteToday()
  }

  const startAt = (i) => {
    if (i >= steps.length) {
      finish()
      return
    }
    iRef.current = i
    setIndex(i)
    const step = steps[i]
    // No-time step: wait for a manual check instead of running a timer.
    if (step.noTime) {
      cancelAnimationFrame(rafRef.current)
      setRemaining(0)
      setProgress(0)
      setPhase('manual')
      return
    }
    const dur = step.seconds
    deadlineRef.current = performance.now() + dur * 1000
    setRemaining(dur)
    setProgress(0)
    setPhase('running')
  }

  const tick = () => {
    const i = iRef.current
    const dur = steps[i].seconds
    const rem = (deadlineRef.current - performance.now()) / 1000
    if (rem <= 0) {
      const next = i + 1
      if (next >= steps.length) {
        // finished a full pass through the set
        markCompleteToday()
        if (set.loop) {
          startAt(0)
          if (!steps[0].noTime) rafRef.current = requestAnimationFrame(tick)
          return
        }
        finish()
        return
      }
      startAt(next)
      // Only keep the RAF loop going if the next step is itself a timer.
      if (!steps[next].noTime) rafRef.current = requestAnimationFrame(tick)
      return
    }
    setRemaining(rem)
    setProgress(1 - rem / dur)
    rafRef.current = requestAnimationFrame(tick)
  }

  // Advance past a no-time step when the user checks it off.
  const manualComplete = () => {
    const i = iRef.current
    if (i < 0 || i >= steps.length) return
    const next = i + 1
    if (next >= steps.length) {
      markCompleteToday()
      if (set.loop) {
        startAt(0)
        return
      }
      finish()
      return
    }
    startAt(next)
  }

  // (re)start the animation loop whenever we enter running phase
  useEffect(() => {
    if (phase === 'running') {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, index])

  // Auto-scroll behaviour:
  // • On resume (paused -> running) center the active timer on screen.
  // • On a normal step advance, align its bottom just above the viewport bottom.
  // • Don't scroll when pausing.
  const prevPhaseRef = useRef('idle')
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (phase === 'idle' || phase === 'paused') return
    const step = index >= 0 && index < steps.length ? steps[index] : null
    const el = step ? nodeRefs.current[step.id] : null
    if (!el) return
    const rect = el.getBoundingClientRect()
    const resumed = prev === 'paused' && phase === 'running'
    let target
    if (resumed) {
      target = rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2
    } else {
      const padding = 24
      target = rect.bottom + window.scrollY - (window.innerHeight - padding)
    }
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [index, phase, steps])

  const handleStart = () => {
    if (steps.length === 0) return
    if (phase === 'paused') {
      const step = steps[iRef.current]
      if (step && step.noTime) {
        setPhase('manual')
        return
      }
      deadlineRef.current = performance.now() + remaining * 1000
      setPhase('running')
      return
    }
    startAt(0)
  }

  const handlePause = () => {
    cancelAnimationFrame(rafRef.current)
    setPhase('paused')
  }

  const handleReset = () => {
    cancelAnimationFrame(rafRef.current)
    iRef.current = -1
    setIndex(-1)
    setProgress(0)
    setRemaining(0)
    setPhase('idle')
  }

  // Skip the current timed step and jump to the next one (keeps running).
  const skipStep = () => {
    const i = iRef.current
    if (i < 0 || i >= steps.length) return
    cancelAnimationFrame(rafRef.current)
    const next = i + 1
    if (next >= steps.length) {
      markCompleteToday()
      if (set.loop) {
        startAt(0)
        return
      }
      finish()
      return
    }
    startAt(next)
  }

  // Single tap on the active timer = pause/resume the whole set.
  const togglePauseResume = () => {
    if (phase === 'running') {
      handlePause()
    } else if (phase === 'paused') {
      handleStart()
    }
  }

  // Distinguish a single tap (pause/resume) from a double tap (skip).
  const handleTimerTap = () => {
    if (tapTimer.current) {
      clearTimeout(tapTimer.current)
      tapTimer.current = null
      skipStep()
      return
    }
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null
      togglePauseResume()
    }, 250)
  }

  const handleFreeze = () => {
    // A completed day can't be frozen.
    if (completedToday) return
    const d = freezableDate(set)
    if (!d) return
    const k = dateKey(d)
    const next = { ...set.freezes }
    if (next[k]) {
      delete next[k]
    } else {
      next[k] = true
    }
    onUpdate({ ...set, freezes: next })
  }

  const streak = computeStreak(set)
  const startActive =
    phase === 'running' ||
    phase === 'paused' ||
    phase === 'manual' ||
    phase === 'done'
  const isActiveRun = phase === 'running' || phase === 'manual'

  // overall progress across the whole set, for the start-button ring
  const totalTime = totalSeconds(set)
  const elapsedBefore = steps
    .slice(0, Math.max(0, index))
    .reduce((a, s) => a + (Number(s.seconds) || 0), 0)
  const curElapsed =
    index >= 0 && index < steps.length ? progress * steps[index].seconds : 0
  const overall =
    phase === 'done'
      ? 1
      : totalTime > 0
        ? Math.min(1, (elapsedBefore + curElapsed) / totalTime)
        : 0
  const overallOffset = OVERALL_C * (1 - overall)
  const overallColor = phase === 'done' ? '#1DB954' : fillColor(overall)
  const oAngle = -90 + 360 * overall
  const oRad = (oAngle * Math.PI) / 180
  const osx = 60 + OVERALL_R * Math.cos(oRad)
  const osy = 60 + OVERALL_R * Math.sin(oRad)
  const showOverallSpark =
    phase === 'running' && overall > 0.001 && overall < 0.999

  const stepStatus = (i) => {
    if (phase === 'done') return 'done'
    if (i < index) return 'done'
    if (i === index) return 'active'
    return 'pending'
  }

  return (
    <div className="run">
      <div className="run-fixed">
        <div className="run-head">
          <button className="icon-btn" onClick={onBack} title="Back" aria-label="Back">
            <Icon name="arrow-left" size={22} />
          </button>
          <button className="icon-btn" onClick={onEdit} title="Edit set" aria-label="Edit set">
            <Icon name="edit" size={18} />
          </button>
        </div>

        <h1 className="run-title">{set.name}</h1>
        <div className="run-meta">
          <span className="meta-tag">{formatDuration(totalSeconds(set))}</span>
          {set.trackStreak && (
            <span className="meta-tag">{streak} day streak</span>
          )}
          {set.trackStreak && (
            <span className="meta-tag">
              {freezesUsed} {freezesUsed === 1 ? 'freeze' : 'freezes'} used
            </span>
          )}
          {set.loop && <span className="meta-tag">Loops</span>}
        </div>

        <div className="run-controls">
          <button
            className={`complete-btn ${completedToday ? 'done' : ''}`}
            onClick={toggleCompleteToday}
            title={completedToday ? 'Completed today — click to undo' : 'Mark this set complete for today'}
            aria-label={completedToday ? 'Completed today' : 'Mark as completed'}
          >
            <Icon name="checkmark" size={24} />
          </button>
          {set.trackStreak && (
            <button
              className={`freeze-btn ${freezeActive ? 'active' : ''}`}
              onClick={handleFreeze}
              disabled={completedToday}
              title={
                completedToday
                  ? "Completed today — can't freeze"
                  : freezeActive
                    ? 'Freeze active — click to remove'
                    : 'Use a freeze to protect your streak'
              }
              aria-label="Freeze streak"
            >
              <Icon name="snowflake" size={24} />
            </button>
          )}
        </div>

        {/* Start node with an overall-progress ring (stays fixed) */}
        <div className="timeline start-timeline">
          <div className="timeline-node">
            <div className="start-wrap">
              <svg viewBox="0 0 120 120" className="overall-ring">
                <circle className="ring-track" cx="60" cy="60" r={OVERALL_R} />
                <circle
                  className="overall-fill"
                  cx="60"
                  cy="60"
                  r={OVERALL_R}
                  stroke={overallColor}
                  strokeDasharray={OVERALL_C}
                  strokeDashoffset={overallOffset}
                />
                {showOverallSpark && (
                  <g className="spark" transform={`translate(${osx} ${osy})`}>
                    <circle r="4.5" className="spark-glow" fill={overallColor} />
                    <circle r="2.4" className="spark-core" />
                  </g>
                )}
              </svg>
              <button
                className={`start-circle ${startActive ? 'engaged' : ''}`}
                onClick={
                  isActiveRun
                    ? handlePause
                    : phase === 'done'
                      ? handleReset
                      : handleStart
                }
                disabled={steps.length === 0}
              >
                {isActiveRun ? (
                  <PauseGlyph />
                ) : phase === 'done' ? (
                  <RestartGlyph />
                ) : (
                  <PlayGlyph />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="timeline run-scroll">
        {steps.map((step, i) => (
          <div
            className="timeline-node"
            key={step.id}
            ref={(el) => {
              if (el) nodeRefs.current[step.id] = el
              else delete nodeRefs.current[step.id]
            }}
          >
            {i > 0 && <div className="connector" />}
            {step.noTime ? (
              <ManualCircle
                step={step}
                status={stepStatus(i)}
                onComplete={manualComplete}
              />
            ) : (
              <TimerCircle
                step={{ ...step, activeRemaining: remaining }}
                status={stepStatus(i)}
                progress={i === index ? progress : 0}
                onTap={handleTimerTap}
                paused={phase === 'paused'}
              />
            )}
          </div>
        ))}

        {steps.length === 0 && (
          <p className="muted" style={{ textAlign: 'center' }}>
            This set has no steps yet. Tap Edit to add some.
          </p>
        )}

        {phase === 'done' && (
          <div className="done-banner">
            <Icon name="checkmark" size={22} /> Set complete — nice work!
          </div>
        )}
      </div>
    </div>
  )
}
