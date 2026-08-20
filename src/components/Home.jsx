import { useState, useRef } from 'react'
import { ClockRegular } from '@fluentui/react-icons/svg/clock'
import { ClipboardTaskRegular } from '@fluentui/react-icons/svg/clipboard-task'
import Icon from './Icon.jsx'
import Avatar from './Avatar.jsx'
import { CheckCircleButton, IconButton } from './PaperButton.jsx'
import { sharingEnabled } from '../feature-flags.js'
import { buddySetForUser } from '../buddy-streaks.js'
import { playComplete, unlockSounds } from '../sound.js'
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
  weekDates,
  ringColor,
  isDoneForToday,
  streakDate,
  toggleSetCompleteToday,
  todayKey,
  WEEKDAYS,
} from '../lib.js'

function FireStrip({ set, compact = false }) {
  const days = normalizeSchedule(set).mode === 'weekly'
    ? weekDates()
    : lastScheduledDates(set, 7)
  return (
    <div className={`fire-strip${compact ? ' compact' : ''}`}>
      {days.map((d) => {
        const k = dateKey(d)
        const done = Boolean(set.completions?.[k])
        const frozen = Boolean(set.freezes?.[k])
        const state = done ? 'done' : frozen ? 'frozen' : 'missed'
        return (
          <div key={k} className="fire-cell" title={`${WEEKDAYS[d.getDay()]} ${k}`}>
            <Icon
              name={frozen ? 'snowflake' : 'fire-element'}
              size={compact ? 16 : 18}
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
    <div className="ring-counter" title={`${done} of ${target} this week`}>
      <div className="weekly-ring">
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
      <small className="ring-counter-label">days</small>
    </div>
  )
}

function BuddyRing({ streak }) {
  const occurrence = streak.currentOccurrence || {}
  const participantIds = occurrence.participantIds || streak.members
    .filter((member) => !member.removedAt && member.role === 'participant')
    .map((member) => member.userId)
  const completedIds = occurrence.completedParticipantIds || []
  const target = participantIds.length
  const done = completedIds.filter((id) => participantIds.includes(id)).length
  const p = target ? Math.min(1, done / target) : 0
  const R = 26
  const C = 2 * Math.PI * R

  return (
    <div className="ring-counter buddy-ring" title={`${done} of ${target} buddies complete`}>
      <div className="weekly-ring">
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
      <small className="ring-counter-label">friends</small>
    </div>
  )
}

function hasParticipatingFriend(streak, userId) {
  const participantIds = streak.currentOccurrence?.participantIds || streak.members
    .filter((member) => !member.removedAt && member.role === 'participant')
    .map((member) => member.userId)
  return participantIds.some((id) => String(id) !== String(userId))
}

function SetCard({
  set,
  buddyStreak,
  nudges = [],
  user,
  spectating = false,
  onOpen,
  onEdit,
  onDelete,
  onShare,
  onComplete,
}) {
  const total = totalSeconds(set)
  const streak = computeStreak(set)
  const activeDate = streakDate()
  const todayK = dateKey(activeDate)
  const dueToday = isScheduled(set, activeDate)
  const doneToday = isDoneForToday(set)
  const frozenToday = Boolean(set.freezes?.[todayK])
  const flameLit = !(dueToday && !doneToday && !frozenToday)
  const weekly = normalizeSchedule(set).mode === 'weekly'
  const participatingFriend = buddyStreak
    ? hasParticipatingFriend(buddyStreak, user.id)
    : false
  const sharedPeople = buddyStreak?.members.filter((member) =>
    !member.removedAt && member.userId !== String(user.id)) || []
  const totalCompletions = Object.values(set.completions || {})
    .filter(Boolean).length
  const streakCounter = set.trackStreak && <div className="streak-count">
    <Icon
      name="fire-element"
      size={18}
      className={`streak-flame ${flameLit ? '' : 'fire-missed'}`}
    />
    <span className="streak-num">{streak}</span>
    <span className="streak-label">{weekly ? 'week streak' : 'day streak'}</span>
  </div>

  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const start = useRef(null)
  const base = useRef(0)
  const moved = useRef(false)
  const wrapRef = useRef(null)
  const REVEAL = 56
  const width = () => wrapRef.current?.offsetWidth || 320
  const updateDx = (value) => {
    dxRef.current = value
    setDx(value)
  }
  const onStart = (x) => {
    unlockSounds()
    start.current = x
    base.current = dxRef.current
    moved.current = false
  }
  const onMove = (x) => {
    if (start.current == null) return
    if (Math.abs(x - start.current) > 6) moved.current = true
    const w = width()
    let raw = base.current + (x - start.current)
    // Amplify rightward travel past 25% so the card is easier to fling off.
    if (raw > 0) {
      const knee = w * 0.25
      if (raw > knee) raw = knee + (raw - knee) * 2.5
      raw = Math.min(w, raw)
    } else {
      raw = Math.max(-REVEAL, raw)
    }
    updateDx(raw)
  }
  const onEnd = () => {
    const finalDx = dxRef.current
    if (finalDx >= width() * 0.9) {
      // Flung fully off-screen → complete, then reset.
      updateDx(width())
      if (!spectating) onComplete()
      setTimeout(() => updateDx(0), 200)
    } else if (finalDx > 0) {
      updateDx(0)
    } else {
      updateDx(finalDx < -REVEAL / 2 ? -REVEAL : 0)
    }
    start.current = null
  }
  const onCancel = () => {
    start.current = null
    updateDx(0)
  }
  const open = () => {
    if (moved.current) return
    if (dxRef.current !== 0) { updateDx(0); return }
    onOpen()
  }

  const completeProgress = Math.max(0, Math.min(1, dx / width()))
  const fillOpacity = Math.pow(completeProgress, 4)

  return (
    <div ref={wrapRef} className={`card-wrap${set.kind === 'task' ? ' task' : ''}`}>
      <div className="card-actions">
        {!spectating && <IconButton variant="swipe" label="Edit" name="edit"
          iconSize={17} iconClassName="action-glyph"
          onClick={() => { updateDx(0); onEdit() }} />}
        {!spectating && sharingEnabled && <IconButton variant="swipe" label="Share streak"
          name="user-add" iconSize={17} iconClassName="action-glyph"
          onClick={() => { updateDx(0); onShare() }} />}
        <IconButton variant="swipe" label={buddyStreak ? 'Leave buddy streak' : 'Delete set'}
          name="trash" iconSize={17} iconClassName="action-glyph"
          className="danger" onClick={() => { updateDx(0); onDelete() }} />
      </div>
      <div className="card-complete">
        <div
          className="card-complete-fill"
          style={{
            opacity: fillOpacity,
            background: doneToday ? 'var(--status-red)' : 'var(--accent-2)',
          }}
        />
        <Icon name={doneToday ? 'close' : 'checkmark'} size={22} />
      </div>
      <div
        className="card"
        style={{ transform: `translateX(${dx}px)` }}
        onClick={open}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          onStart(event.clientX)
        }}
        onPointerMove={(event) => onMove(event.clientX)}
        onPointerUp={onEnd}
        onPointerCancel={onCancel}
      >
        {nudges.length > 0 && !doneToday && <div className="streak-nudge-stack">
          {nudges.map((nudge) => <div className={`streak-nudge-banner level-${nudge.level}`}
            key={nudge.senderId}>
            <span>{nudge.level === 3
              ? <><strong>{nudge.sender}</strong> is <em>aggressively</em> nudging you</>
              : nudge.level === 2
                ? <><strong>{nudge.sender}</strong> nudged you <em>again</em></>
                : <><strong>{nudge.sender}</strong> nudged you</>}</span>
            <button className="streak-nudge-dismiss" type="button"
              aria-label={`Dismiss nudge from ${nudge.sender}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                nudge.dismiss()
              }}>
              <Icon name="close" size={12} />
            </button>
          </div>)}
        </div>}
        <div className="card-head">
          <div>
            <h2 className="card-title">{set.name || 'Untitled'}</h2>
            {buddyStreak && <div className="streak-people" aria-label="People sharing this streak">
              {sharedPeople.map((member) => {
                  const participant = member.role === 'participant'
                  const completed = buddyStreak.currentOccurrence
                    ?.completedParticipantIds?.includes(member.userId)
                  return (
                    <span className="streak-person" key={member.userId}
                      title={`@${member.username}`}>
                      <span className="run-person-avatar">
                        <Avatar user={member} size="small" />
                        {participant && <span className={`run-person-state streak-person-state ${completed ? 'done' : 'waiting'}`}>
                          <Icon name={completed ? 'checkmark' : 'close'} size={10} />
                        </span>}
                      </span>
                      {!participant && <small>Spectator</small>}
                    </span>
                  )
                })}
            </div>}
          </div>
        </div>

        {(set.trackStreak || buddyStreak) && (
          <div className={`card-streak${weekly ? ' weekly-streak' : ''}`}>
            {weekly
              ? <>
                {streakCounter}
                <FireStrip set={set} compact />
                <div className="card-ring-counters">
                  {participatingFriend && <BuddyRing streak={buddyStreak} />}
                  <WeeklyRing set={set} />
                </div>
                </>
              : participatingFriend
                ? <>{streakCounter}<div className="card-ring-counters">
                    <BuddyRing streak={buddyStreak} />
                  </div></>
                : <>{streakCounter}<FireStrip set={set} /></>}
          </div>
        )}
        {!set.trackStreak && !buddyStreak && (
          <div className="card-streak task-completion-summary">
            <div className="streak-count">
              <Icon name="stone" size={20} />
              <span className="streak-num">{totalCompletions}</span>
              <span className="streak-label">times completed</span>
            </div>
            <CheckCircleButton
              complete={doneToday}
              label={doneToday ? 'Undo completion' : 'Mark complete'}
              onChange={onComplete}
            />
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
          {spectating && <span className="meta-tag spectator-tag">Spectating</span>}
        </div>
      </div>
    </div>
  )
}

export default function Home({
  sets,
  user,
  buddy,
  activity = { items: [] },
  onAdd,
  onOpen,
  onEdit,
  onDelete,
  onUpdate,
  onShare,
}) {
  const [confirming, setConfirming] = useState(null) // set pending deletion
  const [choosing, setChoosing] = useState(false)

  const completeCard = (set, buddyStreak) => {
    if (buddyStreak) {
      const completed = buddySetForUser(buddyStreak, user.id).completions?.[todayKey()]
      buddy.setCompletion(buddyStreak.id, !completed).catch(() => {})
      return
    }
    const { set: next, completed } = toggleSetCompleteToday(set)
    onUpdate(next)
    if (completed) playComplete()
  }

  const renderCard = ({ set: s, buddyStreak, spectating = false }) => (
    <SetCard
      key={buddyStreak ? `buddy-${buddyStreak.id}` : s.id}
      set={s}
      buddyStreak={buddyStreak}
      nudges={buddyStreak
        ? (() => {
            const events = activity.items.filter((item) =>
              !item.readAt &&
              item.resourceType === 'buddy_streak' &&
              item.resourceId === buddyStreak.id &&
              item.eventType === 'ping')
            const bySender = new Map()
            for (const event of events) {
              const senderId = event.actor?.userId || `event-${event.id}`
              const existing = bySender.get(senderId)
              if (existing) {
                existing.eventIds.push(event.id)
                continue
              }
              bySender.set(senderId, {
                senderId,
                sender: event.actor?.displayUsername || event.payload?.actorDisplayUsername || 'A friend',
                level: Math.min(3, event.payload?.nudgeNumber || 1),
                eventIds: [event.id],
              })
            }
            return [...bySender.values()].map((nudge) => ({
              ...nudge,
              dismiss: () => nudge.eventIds.forEach((id) => activity.markRead(id)),
            }))
          })()
        : []}
      user={user}
      spectating={spectating}
      onOpen={() => onOpen(s.id, buddyStreak?.id)}
      onEdit={() => buddyStreak?.requestingRole === 'observer'
        ? onOpen(s.id, buddyStreak.id)
        : onEdit(s.id, buddyStreak?.id)}
      onDelete={() => setConfirming({ set: s, buddyStreak })}
      onShare={() => onShare(s, buddyStreak)}
      onComplete={() => completeCard(s, buddyStreak)}
    />
  )

  const participantStreaks = buddy.buddyStreaks.filter(
    (streak) => streak.requestingRole === 'participant',
  )
  const entries = sets.map((set) => {
    const buddyStreak = participantStreaks.find((streak) => streak.legacySetId === set.id)
    return {
      set: buddyStreak ? buddySetForUser(buddyStreak, user.id, set) : set,
      buddyStreak,
    }
  })
  for (const streak of participantStreaks) {
    if (!streak.legacySetId || !sets.some((set) => set.id === streak.legacySetId)) {
      entries.push({ set: buddySetForUser(streak, user.id), buddyStreak: streak })
    }
  }
  const todo = []
  const done = []
  for (const entry of entries) {
    const s = entry.set
    const activeDate = streakDate()
    const dueToday = isScheduled(s, activeDate)
    const isDone = isDoneForToday(s)
    const frozen = Boolean(s.freezes?.[dateKey(activeDate)])
    if (dueToday && !isDone && !frozen) todo.push(entry)
    else done.push(entry)
  }
  const spectatorGroups = buddy.buddyStreaks
    .filter((streak) => streak.requestingRole === 'observer')
    .reduce((groups, streak) => {
      const owner = streak.members.find((member) =>
        member.userId === streak.createdByUserId)
      const key = owner?.userId || streak.createdByUserId
      if (!groups[key]) groups[key] = { owner, entries: [] }
      groups[key].entries.push({
        set: buddySetForUser(streak, user.id),
        buddyStreak: streak,
        spectating: true,
      })
      groups[key].entries.sort((a, b) =>
        Number(a.buddyStreak.currentOccurrence?.complete) -
        Number(b.buddyStreak.currentOccurrence?.complete))
      return groups
    }, {})

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
            <Icon name="plus" size={22} />
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
            <Icon name="plus" size={22} />
          </button>
        </div>
      ) : (
        <>
          {todo.length > 0 && (
            <section className="home-section todo-section">
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

      {Object.values(spectatorGroups).map(({ owner, entries: groupEntries }) => (
        <section className="home-section spectator-section" key={owner?.userId || 'shared'}>
          <h2 className="section-title">
            {owner?.displayUsername || owner?.username || 'Shared'}’s streaks
          </h2>
          <div className="card-grid">{groupEntries.map(renderCard)}</div>
        </section>
      ))}

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
                <ClockRegular className="gi" fontSize={40} aria-hidden="true" />
                <span>Timer</span>
              </button>
              <button
                className="chooser-btn task"
                onClick={() => { setChoosing(false); onAdd('task') }}
              >
                <ClipboardTaskRegular className="gi" fontSize={40} aria-hidden="true" />
                <span>Task</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div className="modal-overlay" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">
              {confirming.buddyStreak ? 'Leave buddy streak?' : 'Delete set?'}
            </h3>
            <p className="modal-body">
              {confirming.buddyStreak
                ? 'This removes the shared streak from your account. Other members keep access.'
                : <>“{confirming.set.name}” and its streak history will be permanently
                    removed. This can’t be undone.</>}
            </p>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                className="danger-btn"
                onClick={() => {
                  if (confirming.buddyStreak) {
                    buddy.leave(confirming.buddyStreak.id, String(user.id)).catch(() => {})
                  } else {
                    onDelete(confirming.set.id)
                  }
                  setConfirming(null)
                }}
              >
                {confirming.buddyStreak ? 'Leave' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
