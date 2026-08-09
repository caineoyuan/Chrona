import { useState } from 'react'
import { createPortal } from 'react-dom'
import GroupInvitesIcon from './GroupInvitesIcon.jsx'
import Icon from './Icon.jsx'

function invitationTitle(invitation) {
  const resource = invitation.resourceType === 'buddy_streak'
    ? 'Buddy streak'
    : 'Medication list'
  return invitation.invitedByUsername
    ? `${resource} from @${invitation.invitedByUsername}`
    : `${resource} invitation`
}

function invitationAccess(invitation) {
  const role = invitation.permissions?.role
  const access = role ? `${role[0].toUpperCase()}${role.slice(1)}` : 'Shared access'
  if (invitation.resourceType !== 'medication_list') return access
  const history = invitation.permissions?.can_view_history
    ?? invitation.permissions?.canViewHistory
  return `${access} · ${history ? 'Dose history & schedule' : 'Medication list'}`
}

export default function InvitationInbox({ activity }) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const inviteCount = activity.pendingInvites.length

  const act = async (invitation, action, accepted = false) => {
    setBusyId(invitation.id)
    try {
      await action(invitation.id)
      if (accepted) window.dispatchEvent(new CustomEvent('chrona:invite-accepted'))
    } catch {
      // The hook displays the server response in the modal.
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <button type="button" className={`invitation-inbox-trigger ${open ? 'active' : ''}`}
        aria-label={`Invites${inviteCount ? `, ${inviteCount} pending` : ''}`}
        aria-expanded={open} aria-haspopup="dialog"
        onClick={() => {
          setOpen(true)
          activity.refresh()
        }}>
        <GroupInvitesIcon size={28} />
        {inviteCount > 0 && <span className="invitation-count">{inviteCount}</span>}
      </button>

      {open && createPortal(<div className="modal-overlay invitation-overlay"
        onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="modal invitation-modal" role="dialog" aria-modal="true"
          aria-labelledby="invitation-title">
          <header className="invitation-modal-head">
            <div className="invitation-modal-title">
              <GroupInvitesIcon size={32} />
              <h2 className="modal-title" id="invitation-title">Invites</h2>
            </div>
            <button type="button" className="icon-btn" aria-label="Close invites"
              onClick={() => setOpen(false)}>
              <Icon name="close" size={20} />
            </button>
          </header>
          <div className="invitation-modal-body">
            {activity.error && <p className="sharing-feedback error" role="alert">
              {activity.error}
            </p>}
            {!activity.loaded && <p className="invitation-empty">Loading invites…</p>}
            {activity.loaded && !inviteCount && <p className="invitation-empty">No invites.</p>}
            {activity.pendingInvites.map((invitation) => (
              <article className="invitation-row" key={invitation.id}>
                <div>
                  <strong>{invitationTitle(invitation)}</strong>
                  <small>{invitationAccess(invitation)}</small>
                </div>
                <div className="invitation-actions">
                  <button type="button" className="invitation-action accept"
                    aria-label={`Accept ${invitationTitle(invitation)}`}
                    disabled={busyId === invitation.id}
                    onClick={() => act(invitation, activity.accept, true)}>
                    <Icon name="checkmark" size={20} />
                  </button>
                  <button type="button" className="invitation-action reject"
                    aria-label={`Reject ${invitationTitle(invitation)}`}
                    disabled={busyId === invitation.id}
                    onClick={() => act(invitation, activity.reject)}>
                    <Icon name="close" size={20} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>, document.body)}
    </>
  )
}
