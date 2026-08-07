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

export default function Profile({ onClose, themePreference, onThemeChange }) {
  const { user, logout, changePassword } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const notificationsSupported = pushSupported()
  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isStandalone = typeof window !== 'undefined'
    && (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true)
  const notificationHelp = !notificationsSupported
    ? isIos && !isStandalone
      ? 'On iPhone or iPad, add Chrona to the Home Screen and open it there to enable notifications.'
      : 'Web Push is not supported by this browser or device.'
    : Notification.permission === 'denied'
      ? 'Notifications are blocked. Allow them in this device’s browser or app settings, then re-register.'
      : Notification.permission === 'granted'
        ? 'Notifications are allowed on this device.'
        : 'Tap “Send test notification” to request notification permission.'

  const sendTest = async () => {
    setTestMsg('Sending…')
    try {
      const ok = await subscribePush()
      if (!ok) {
        setTestMsg('Notifications were not allowed or are unavailable on this device.')
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
          : 'Notifications were not allowed or are unavailable on this device.',
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
          <section className="appearance-section">
            <h3 className="section-title">Appearance</h3>
            <div className="theme-options" role="radiogroup" aria-label="Color theme">
              {['system', 'light', 'dark'].map((option) => (
                <button key={option} type="button" role="radio"
                  aria-checked={themePreference === option}
                  className={themePreference === option ? 'active' : ''}
                  onClick={() => onThemeChange(option)}>
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <p className="setting-help">System follows this device’s appearance setting.</p>
          </section>
          <section className="notification-section">
            <h3 className="section-title">Notifications</h3>
            <p className="setting-help">{notificationHelp}</p>
            <div className="notification-actions">
              <button type="button" className="logout-btn" disabled={!notificationsSupported}
                onClick={sendTest} title="Send a test notification">
                Send test notification
              </button>
              <button type="button" className="logout-btn" disabled={!notificationsSupported}
                onClick={reregister} title="Fix stuck notifications by re-registering this device">
                Re-register notifications
              </button>
            </div>
            {testMsg && <p className="auth-success">{testMsg}</p>}
          </section>
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
