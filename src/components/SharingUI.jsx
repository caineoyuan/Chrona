import { useMemo, useRef, useState } from 'react'
import { ArrowRightRegular } from '@fluentui/react-icons/svg/arrow-right'
import { api } from '../auth.jsx'
import { useActivity } from '../activity.js'
import { useBuddyStreaks } from '../buddy-streaks.js'
import { invitationClient } from '../invitations.js'
import Avatar from './Avatar.jsx'
import Icon from './Icon.jsx'
import { IconButton as ButtonIcon } from './PaperButton.jsx'

function currentStatus(streak, userId) {
  const occurrence = streak.currentOccurrence || {
    participantIds: [],
    completedParticipantIds: [],
    complete: false,
  }
  const completed = new Set(occurrence.completedParticipantIds || [])
  return {
    occurrence,
    completed,
    selfCompleted: streak.optimisticCompleted === undefined
      ? completed.has(String(userId))
      : streak.optimisticCompleted,
  }
}

function activityCopy(item) {
  const actor = item.actor?.displayUsername || item.actor?.username || 'Someone'
  const copy = {
    invite: `${actor} invited you to a shared resource.`,
    accepted: `${actor} accepted your invitation.`,
    completed: `${actor} completed a shared streak.`,
    ping: `${actor} sent you a streak ping.`,
    edited: `${actor} updated a shared streak.`,
    removed: `${actor} changed shared streak access.`,
    automatic_reminder: 'A shared streak still needs attention.',
  }
  return copy[item.eventType] || 'Shared activity was updated.'
}

function ActivityInbox({ activity, onAccepted, onClose }) {
  const acceptInvite = async (id) => {
    try {
      await activity.accept(id)
      await onAccepted()
    } catch {
      // The hook exposes the actionable server error in the inbox.
    }
  }
  return (
    <div className="modal-overlay sharing-overlay" onMouseDown={(event) =>
      event.target === event.currentTarget && onClose()}>
      <section className="modal sharing-sheet" aria-labelledby="activity-title">
        <header className="sharing-sheet-head">
          <div>
            <span className="eyebrow">Collaboration</span>
            <h2 className="modal-title" id="activity-title">Activity</h2>
          </div>
          <ButtonIcon name="close" label="Close activity" onClick={onClose} />
        </header>
        {activity.error && <p className="sharing-feedback error" role="alert">{activity.error}</p>}
        {activity.unreadCount > 0 && (
          <button className="text-action" type="button" onClick={activity.markAllRead}>
            Mark all read
          </button>
        )}
        {activity.pendingInvites.map((invite) => (
          <article className="activity-row unread" key={`invite-${invite.id}`}>
            <div>
              <strong>Shared {invite.resourceType === 'buddy_streak' ? 'streak' : 'medication'} invitation</strong>
              <span>Access expires {new Date(invite.expiresAt).toLocaleDateString()}.</span>
            </div>
            <button className="primary-text-action" type="button"
              onClick={() => acceptInvite(invite.id)}>Accept</button>
          </article>
        ))}
        {!activity.loaded && <p className="sharing-empty">Loading activity…</p>}
        {activity.loaded && !activity.items.length && !activity.pendingInvites.length &&
          <p className="sharing-empty">No shared activity yet.</p>}
        {activity.items.map((item) => (
          <button
            className={`activity-row activity-button ${item.readAt ? '' : 'unread'}`}
            key={item.id}
            type="button"
            onClick={() => activity.markRead(item.id)}
          >
            <span><strong>{activityCopy(item)}</strong>
              <small>{new Date(item.createdAt).toLocaleString()}</small></span>
            {!item.readAt && <i aria-label="Unread" />}
          </button>
        ))}
      </section>
    </div>
  )
}

export function BuddyShareModal({
  streak,
  userId,
  actions,
  onClose,
  initialRole = 'participant',
}) {
  const invitations = useRef(invitationClient(api))
  const [role, setRole] = useState(initialRole)
  const [username, setUsername] = useState('')
  const [streakName, setStreakName] = useState(streak.definition?.name || '')
  const [link, setLink] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)

  const run = async (work, success) => {
    setBusy(true)
    setFeedback('')
    try {
      await work()
      setFeedback(success)
    } catch (error) {
      setFeedback(error.status === 409
        ? 'This streak changed elsewhere. The latest member list has been reloaded.'
        : error.message)
    } finally {
      setBusy(false)
    }
  }

  const createLink = () => run(async () => {
    const result = await invitations.current.createLink(
      streak.id,
      { role },
      'buddy_streak',
    )
    setLink(new URL(result.invitePath, window.location.origin).toString())
  }, 'Invitation link created.')

  return (
    <div className="modal-overlay sharing-overlay" onMouseDown={(event) =>
      event.target === event.currentTarget && onClose()}>
      <section className="modal sharing-sheet" aria-labelledby="share-title" aria-busy={busy}>
        <header className="sharing-sheet-head">
          <div><h2 className="modal-title" id="share-title">{streak.definition?.name || 'Shared streak'}</h2></div>
          <ButtonIcon name="close" label="Close sharing" onClick={onClose} />
        </header>
        {feedback && <p className={`sharing-feedback ${feedback.includes('changed') ? 'error' : ''}`}
          role="status">{feedback}</p>}
        <form className="buddy-create-form" onSubmit={(event) => {
          event.preventDefault()
          if (!streakName.trim() || streakName.trim() === streak.definition?.name) return
          run(
            () => actions.update(streak.id, {
              ...streak.definition,
              name: streakName.trim(),
            }),
            'Shared streak updated.',
          )
        }}>
          <label htmlFor="shared-streak-name">Shared streak name</label>
          <div className="buddy-inline-field">
            <input id="shared-streak-name" value={streakName}
              onChange={(event) => setStreakName(event.target.value)} maxLength={200} />
          </div>
        </form>
        <fieldset className="buddy-role-picker">
          <legend>Invitation access</legend>
          <div>
            <button type="button" className={role === 'participant' ? 'active' : ''}
              aria-pressed={role === 'participant'}
              onClick={() => setRole('participant')}>Buddy streak</button>
            <button type="button" className={role === 'observer' ? 'active' : ''}
              aria-pressed={role === 'observer'}
              onClick={() => setRole('observer')}>Spectating</button>
          </div>
          <small>{role === 'participant'
            ? 'Can complete, share, edit access, remove members, or delete the streak.'
            : 'Can view status and send pings, but cannot complete or administer.'}</small>
        </fieldset>
        <form className="buddy-invite-form" onSubmit={(event) => {
          event.preventDefault()
          if (!username.trim()) return
          run(
            () => invitations.current.inviteUsername(
              streak.id,
              username.trim(),
              { role },
              'buddy_streak',
            ),
            'Invitation sent if that exact username exists.',
          )
          setUsername('')
        }}>
          <label htmlFor="buddy-username">Invite by exact username</label>
          <div><input id="buddy-username" value={username} onChange={(event) =>
            setUsername(event.target.value)} autoCapitalize="none" autoCorrect="off" />
            <button className="secondary-text-action" disabled={busy || !username.trim()}>Invite</button></div>
        </form>
        <div className="buddy-link-actions">
          <button className="secondary-text-action" type="button" disabled={busy}
            onClick={createLink}>Create invitation link</button>
          {link && <div className="generated-buddy-link">
            <input readOnly value={link} aria-label="Buddy invitation link"
              onFocus={(event) => event.target.select()} />
            <ButtonIcon name="copy" label="Copy invitation link" onClick={async () => {
              try {
                await navigator.clipboard.writeText(link)
                setFeedback('Invitation link copied.')
              } catch {
                setFeedback('Copy failed. Select and copy the link manually.')
              }
            }} />
          </div>}
        </div>
        <section className="share-management" aria-labelledby="members-title">
          <h3 id="members-title">People with access</h3>
          {streak.members.filter((member) => !member.removedAt).map((member) => (
            <div className="share-row" key={member.userId}>
              <Avatar user={member} size="medium" />
              <span><strong>@{member.username}</strong>
                <small>{member.role === 'participant' ? 'Buddy' : 'Spectator'}
                  {member.userId === String(userId) ? ' · You' : ''}</small>
              </span>
              {member.userId !== String(userId) &&
                <ButtonIcon name="trash" label={`Remove ${member.displayUsername}`}
                  className="danger"
                  disabled={busy} onClick={() => setConfirm(member)} />}
            </div>
          ))}
        </section>
        {confirm && <div className="inline-confirm" role="alertdialog" aria-modal="true">
          <strong>{`Remove ${confirm.displayUsername}?`}</strong>
          <span>This affects everyone with access and cannot be undone.</span>
          <div><button className="secondary-text-action" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="danger-text-action" onClick={() => run(async () => {
              await actions.removeMember(streak.id, confirm.userId)
              setConfirm(null)
            }, 'Member removed.')}>Confirm</button></div>
        </div>}
        <footer className="sharing-sheet-footer">
          <button className="primary-text-action" type="button"
            disabled={busy || !streakName.trim()}
            onClick={() => {
              const nextName = streakName.trim()
              if (nextName === streak.definition?.name) {
                onClose()
                return
              }
              run(async () => {
                await actions.update(streak.id, {
                  ...streak.definition,
                  name: nextName,
                })
                onClose()
              }, 'Shared streak updated.')
            }}>Save</button>
        </footer>
      </section>
    </div>
  )
}

export function SharingChoiceModal({ set, busy, error, onChoose, onClose }) {
  return (
    <div className="modal-overlay sharing-overlay" onMouseDown={(event) =>
      event.target === event.currentTarget && onClose()}>
      <section className="modal sharing-sheet sharing-choice" role="dialog"
        aria-modal="true" aria-labelledby="sharing-choice-title">
        <header className="sharing-sheet-head">
          <div><span className="eyebrow">Share streak</span>
            <h2 className="modal-title" id="sharing-choice-title">
              {set.name || 'Untitled'}
            </h2></div>
          <ButtonIcon name="close" label="Close sharing" onClick={onClose} />
        </header>
        <p>What kind of sharing?</p>
        {error && <p className="sharing-feedback error">{error}</p>}
        <div className="sharing-kind-options">
          <button type="button" disabled={busy} onClick={() => onChoose('participant')}>
            <strong>Buddy Streak</strong>
            <small>Friends participate and complete the streak together.</small>
          </button>
          <button type="button" disabled={busy} onClick={() => onChoose('observer')}>
            <strong>Viewing</strong>
            <small>Friends spectate progress without completing the streak.</small>
          </button>
        </div>
      </section>
    </div>
  )
}

export function NudgeModal({ member, count, busy, error, onConfirm, onClose }) {
  const level = Math.min(3, count + 1)
  return (
    <div className="modal-overlay sharing-overlay" onMouseDown={(event) =>
      event.target === event.currentTarget && onClose()}>
      <section className="modal nudge-modal" role="alertdialog" aria-modal="true"
        aria-labelledby="nudge-title">
        <h2 className="modal-title" id="nudge-title">
          {level === 3
            ? <><em>Aggressively</em> nudge {member.displayUsername} <em>again</em>?</>
            : level === 2
              ? <>Nudge {member.displayUsername} <em>again</em>?</>
              : <>Nudge {member.displayUsername}?</>}
        </h2>
        {error && <p className="sharing-feedback error" role="alert">{error}</p>}
        <div className="nudge-actions">
          <button className="nudge-action cancel" type="button" onClick={onClose}
            aria-label="Cancel nudge">
            <Icon name="close" size={22} />
          </button>
          <button className="nudge-action confirm" type="button"
            disabled={busy} onClick={onConfirm} aria-label="Send nudge">
            <ArrowRightRegular fontSize={22} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  )
}

function BuddyCard({ streak, user, actions, onShare }) {
  const { occurrence, completed, selfCompleted } = currentStatus(streak, user.id)
  const [pingState, setPingState] = useState({})
  const observer = streak.requestingRole === 'observer'
  const activeMembers = streak.members.filter((member) => !member.removedAt)
  const ping = async (member) => {
    setPingState((state) => ({ ...state, [member.userId]: 'Sending…' }))
    try {
      await actions.ping(streak.id, member.userId)
      setPingState((state) => ({ ...state, [member.userId]: 'Ping sent' }))
    } catch (error) {
      setPingState((state) => ({
        ...state,
        [member.userId]: error.status === 429
          ? 'Hourly ping limit reached'
          : error.message,
      }))
    }
  }
  return (
    <div className={`card-wrap buddy-card-wrap ${occurrence.complete ? 'complete' : ''}`}>
      <article className="card buddy-card">
        <header className="card-head">
          <div><h2 className="card-title">{streak.definition?.name || 'Shared streak'}</h2>
            <div className="buddy-meta"><span>{observer ? 'Observer' : 'Participant'}</span>
              <span>{streak.groupStreak || 0} group streak</span>
              {occurrence.complete && <span className="success">All members complete</span>}</div></div>
          {streak.canAdminister && <ButtonIcon name="user-add" label="Share and manage members"
            onClick={() => onShare(streak)} />}
        </header>
        <div className="buddy-member-status">
          {activeMembers.map((member) => {
            const done = completed.has(member.userId)
            const self = member.userId === String(user.id)
            return <div className="buddy-status-row" key={member.userId}>
              <span className={`buddy-state-mark ${done ? 'done' : ''}`}>
                <Icon name={done ? 'checkmark' : 'timer'} size={18} /></span>
              <span><strong>{member.displayUsername}{self ? ' (you)' : ''}</strong>
                <small>{member.role}{done ? ' · complete' : member.role === 'participant' ? ' · waiting' : ''}</small></span>
              {!self && member.role === 'participant' && !done &&
                <button className="ping-action" type="button" onClick={() => ping(member)}
                  disabled={pingState[member.userId] === 'Sending…'}>
                  <Icon name="bell" size={18} /> Ping
                </button>}
              {pingState[member.userId] && <small className="ping-feedback" role="status">
                {pingState[member.userId]}</small>}
            </div>
          })}
        </div>
        {observer
          ? <p className="observer-note">Read-only observer — completion and administration are disabled.</p>
          : <button className={`buddy-complete-action ${selfCompleted ? 'undo' : ''}`}
              type="button" disabled={streak.completionSyncPending}
              onClick={() => actions.setCompletion(streak.id, !selfCompleted)}>
              <Icon name={selfCompleted ? 'close' : 'checkmark'} size={20} />
              {selfCompleted ? 'Undo my completion' : 'Complete my part'}
            </button>}
      </article>
    </div>
  )
}

export default function SharingUI({ sets, user }) {
  const buddy = useBuddyStreaks()
  const activity = useActivity()
  const [sharing, setSharing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [inbox, setInbox] = useState(false)
  const [name, setName] = useState('')
  const [feedback, setFeedback] = useState('')
  const privateSets = useMemo(() => sets.filter((set) =>
    !buddy.buddyStreaks.some((streak) => streak.legacySetId === set.id)), [
    buddy.buddyStreaks,
    sets,
  ])

  const create = async (event) => {
    event.preventDefault()
    if (!name.trim()) return
    try {
      await buddy.create({
        name: name.trim(),
        kind: 'task',
        steps: [{ type: 'exercise', name: name.trim(), seconds: 0, noTime: true }],
        schedule: [],
        trackStreak: true,
        createdAt: new Date().toISOString(),
      })
      setName('')
      setCreating(false)
      setFeedback('Buddy streak created.')
    } catch (error) {
      setFeedback(error.message)
    }
  }

  return (
    <section className="home-section sharing-home" aria-labelledby="buddy-title">
      <header className="sharing-home-head">
        <div><span className="eyebrow">Together</span><h2 className="section-title" id="buddy-title">Buddy streaks</h2></div>
        <div>
          <button className="activity-trigger" type="button" onClick={() => setInbox(true)}
            aria-label={`Activity${activity.unreadCount ? `, ${activity.unreadCount} unread` : ''}`}>
            <Icon name="bell" size={20} />
            {activity.unreadCount > 0 && <span>{activity.unreadCount}</span>}
          </button>
          <ButtonIcon name="plus" label="Create or promote a buddy streak"
            onClick={() => setCreating(true)} />
        </div>
      </header>
      {(buddy.conflict || feedback) && <p className={`sharing-feedback ${buddy.conflict ? 'error' : ''}`}
        role="status">{buddy.conflict || feedback}
        {buddy.conflict && <button type="button" onClick={buddy.clearConflict}>Dismiss</button>}</p>}
      {!buddy.loaded && <p className="sharing-empty">Loading buddy streaks…</p>}
      {buddy.loaded && !buddy.buddyStreaks.length &&
        <p className="sharing-empty">Create one here or promote an existing private streak.</p>}
      <div className="card-grid">
        {buddy.buddyStreaks.map((streak) => <BuddyCard key={streak.id} streak={streak}
          user={user} actions={buddy} onShare={setSharing} />)}
      </div>
      {creating && <div className="modal-overlay sharing-overlay" onMouseDown={(event) =>
        event.target === event.currentTarget && setCreating(false)}>
        <section className="modal sharing-sheet" aria-labelledby="create-buddy-title">
          <header className="sharing-sheet-head"><div><span className="eyebrow">Together</span>
            <h2 className="modal-title" id="create-buddy-title">New buddy streak</h2></div>
            <ButtonIcon name="close" label="Close" onClick={() => setCreating(false)} /></header>
          <form className="buddy-create-form" onSubmit={create}>
            <label htmlFor="buddy-name">Streak name</label>
            <input id="buddy-name" value={name} onChange={(event) => setName(event.target.value)}
              maxLength={200} autoFocus />
            <button className="primary-text-action" disabled={!name.trim()}>Create</button>
          </form>
          {privateSets.length > 0 && <section className="promote-list">
            <h3>Promote a private streak</h3>
            <p>Its existing completion history is copied into the shared streak.</p>
            {privateSets.map((set) => <button className="promote-row" type="button" key={set.id}
              onClick={async () => {
                try {
                  await buddy.promote(set.id)
                  setCreating(false)
                  setFeedback(`“${set.name || 'Untitled'}” is now a buddy streak.`)
                } catch (error) {
                  setFeedback(error.message)
                }
              }}><span>{set.name || 'Untitled'}</span><Icon name="arrow-right" size={18} /></button>)}
          </section>}
        </section>
      </div>}
      {sharing && <BuddyShareModal streak={buddy.buddyStreaks.find(({ id }) => id === sharing.id) || sharing}
        userId={user.id} actions={buddy} onClose={() => setSharing(null)} />}
      {inbox && <ActivityInbox activity={activity} onClose={() => setInbox(false)}
        onAccepted={async () => { await buddy.refetch(); await activity.refresh() }} />}
    </section>
  )
}
