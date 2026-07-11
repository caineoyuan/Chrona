import { useState } from 'react'
import Icon from './Icon.jsx'
import { useAuth } from '../auth.jsx'
import { api } from '../auth.jsx'
import { subscribePush, reregisterPush, pushSupported } from '../push.js'

function PasswordField({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false)
  return (
    <div className="password-field">
      <input
        className="auth-input"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className={`eye-btn ${show ? 'on' : ''}`}
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide password' : 'Show password'}
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        <Icon name="eye" size={20} />
      </button>
    </div>
  )
}

export default function Profile({ onClose }) {
  const { user, logout, changePassword } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState('')

  const sendTest = async () => {
    setTestMsg('Sending…')
    try {
      const ok = await subscribePush()
      if (!ok) {
        setTestMsg('Enable notifications first (tap a set’s bell and allow).')
        return
      }
      const r = await api('/api/push/test', { method: 'POST' })
      setTestMsg(`Sent to ${r.sent} device(s). Check your notifications.`)
    } catch (e) {
      setTestMsg(e.message || 'Could not send test.')
    }
  }

  const reregister = async () => {
    setTestMsg('Re-registering…')
    try {
      const ok = await reregisterPush()
      setTestMsg(
        ok
          ? 'Notifications re-registered. Try "Send test notification".'
          : 'Enable notifications first (tap a set’s bell and allow).',
      )
    } catch (e) {
      setTestMsg(e.message || 'Could not re-register.')
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setDone(false)
    setBusy(true)
    try {
      await changePassword({ currentPassword, newPassword, confirm })
      setDone(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-head">
          <div className="profile-id">
            <Icon name="profile" size={34} />
            <span className="profile-name">{user?.username}</span>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <form className="profile-form" onSubmit={submit}>
          {pushSupported() && (
            <>
              <h3 className="section-title">Notifications</h3>
              <button type="button" className="logout-btn" onClick={sendTest} title="Send a test notification">
                Send test notification
              </button>
              <button type="button" className="logout-btn" onClick={reregister} title="Fix stuck notifications by re-registering this device">
                Re-register notifications
              </button>
              {testMsg && <p className="auth-success">{testMsg}</p>}
            </>
          )}
          <h3 className="section-title">Change password</h3>

          <label className="auth-label">Current password</label>
          <PasswordField
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="current password"
            autoComplete="current-password"
          />

          <label className="auth-label">New password</label>
          <PasswordField
            value={newPassword}
            onChange={setNewPassword}
            placeholder="new password"
            autoComplete="new-password"
          />

          <label className="auth-label">Confirm new password</label>
          <PasswordField
            value={confirm}
            onChange={setConfirm}
            placeholder="re-enter new password"
            autoComplete="new-password"
          />
          {confirm && confirm !== newPassword && (
            <p className="mismatch-msg">Passwords do not match</p>
          )}

          {error && <p className="auth-error">{error}</p>}
          {done && <p className="auth-success">Password updated.</p>}

          <div className="profile-actions">
            <button
              type="button"
              className="logout-btn"
              onClick={logout}
              title="Sign out"
            >
              Sign out
            </button>
            <button
              type="submit"
              className="auth-submit small"
              disabled={busy}
              title="Save new password"
              aria-label="Save new password"
            >
              <Icon name="checkmark" size={22} />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
