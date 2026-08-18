import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'
import { IconButton } from './PaperButton.jsx'
import Avatar from './Avatar.jsx'
import { api, useAuth } from '../auth.jsx'
import {
  currentPushEndpoint,
  pushSupported,
  reregisterPush,
  subscribePush,
} from '../push.js'
import {
  AVATAR_COLORS,
  cropGeometry,
  defaultAvatarFor,
  resolvedAvatar,
} from '../profile-avatar.js'

const CROP_SIZE = 208
const OUTPUT_SIZE = 256
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

function PasswordField({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false)
  return (
    <div className="password-field">
      <input className="auth-input" type={show ? 'text' : 'password'}
        value={value} placeholder={placeholder} autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)} />
      <button type="button" className={`eye-btn ${show ? 'on' : ''}`}
        onClick={() => setShow((value) => !value)}
        title={show ? 'Hide password' : 'Show password'}
        aria-label={show ? 'Hide password' : 'Show password'}>
        <Icon name="eye" size={20} />
      </button>
    </div>
  )
}

function imageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not read this image.'))
    image.src = url
  })
}

async function croppedImageBlob(url, zoom, offset) {
  const image = await imageElement(url)
  const geometry = cropGeometry(
    { width: image.naturalWidth, height: image.naturalHeight },
    CROP_SIZE,
    zoom,
    offset.x,
    offset.y,
  )
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const context = canvas.getContext('2d')
  context.drawImage(
    image,
    geometry.sourceX,
    geometry.sourceY,
    geometry.sourceSize,
    geometry.sourceSize,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  )
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Could not prepare this image.')),
      'image/png',
    )
  })
}

function AvatarEditor({ user, onCancel }) {
  const {
    updateAvatarChoice,
    uploadAvatar,
  } = useAuth()
  const fallback = defaultAvatarFor(user)
  const [choice, setChoice] = useState(() => resolvedAvatar(user))
  const [uploadUrl, setUploadUrl] = useState('')
  const [imageSize, setImageSize] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const drag = useRef(null)

  useEffect(() => () => {
    if (uploadUrl) URL.revokeObjectURL(uploadUrl)
  }, [uploadUrl])

  const chooseInitial = (color) => {
    setChoice({ ...fallback, color })
    setUploadUrl('')
    setImageSize(null)
    setStatus('')
    setError('')
  }

  const chooseFile = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image. SVG images are not allowed.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('Choose an image that is 5 MB or smaller.')
      return
    }
    setError('')
    setStatus('')
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setImageSize(null)
    setUploadUrl(URL.createObjectURL(file))
  }

  const geometry = uploadUrl && imageSize
    ? cropGeometry(imageSize, CROP_SIZE, zoom, offset.x, offset.y)
    : null

  const moveCrop = (x, y) => {
    if (!imageSize) return
    const next = cropGeometry(imageSize, CROP_SIZE, zoom, x, y)
    setOffset({ x: next.x, y: next.y })
  }

  const handlePointerDown = (event) => {
    if (!geometry) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset,
    }
  }

  const handlePointerMove = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return
    moveCrop(
      drag.current.offset.x + event.clientX - drag.current.startX,
      drag.current.offset.y + event.clientY - drag.current.startY,
    )
  }

  const handlePointerUp = (event) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }

  const handleCropKeys = (event) => {
    const amount = event.shiftKey ? 10 : 2
    const movement = {
      ArrowLeft: [amount, 0],
      ArrowRight: [-amount, 0],
      ArrowUp: [0, amount],
      ArrowDown: [0, -amount],
    }[event.key]
    if (!movement) return
    event.preventDefault()
    moveCrop(offset.x + movement[0], offset.y + movement[1])
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setStatus('Saving avatar…')
    try {
      let profile
      if (uploadUrl) {
        profile = await uploadAvatar(await croppedImageBlob(uploadUrl, zoom, offset))
      } else {
        profile = await updateAvatarChoice(
          choice.type === 'bundled'
            ? { type: 'bundled', id: choice.id }
            : { type: 'initial', color: choice.color },
        )
      }
      setChoice(profile.avatar)
      setUploadUrl('')
      setImageSize(null)
      setStatus('Avatar saved.')
      onCancel()
    } catch (saveError) {
      setError(saveError.message || 'Could not save avatar.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const previewUser = { ...user, avatar: choice }

  return (
    <section className="avatar-section" aria-labelledby="profile-icon-editor-title">
      <div className="avatar-section-heading">
        <div>
          <h2 className="section-title" id="profile-icon-editor-title">Edit profile icon</h2>
          <p className="setting-help">Choose how your profile appears in Chrona and Medira.</p>
        </div>
        {!uploadUrl && <Avatar user={previewUser} size="preview" />}
      </div>

      <div className="avatar-setting-grid">
        <fieldset className="avatar-options">
          <legend>Background color</legend>
          <div className="avatar-color-grid">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="avatar-color"
                style={{
                  '--avatar-color': `#${color}`,
                }}
                aria-label={`Use avatar color #${color}`}
                aria-pressed={!uploadUrl && choice.type === 'initial' && choice.color === color}
                onClick={() => chooseInitial(color)}
              >
                <span aria-hidden="true">{fallback.initial}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="avatar-options avatar-upload">
          <legend>Choose an image</legend>
          <label className="secondary-text-button">
            Choose image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={chooseFile}
              disabled={busy}
            />
          </label>
          <span>PNG, JPEG, or WebP<br />5 MB maximum</span>
        </fieldset>
      </div>

      {uploadUrl && (
        <div className="avatar-crop-panel">
          <div
            className="avatar-crop"
            role="group"
            tabIndex="0"
            aria-label="Avatar crop. Drag the image, or use arrow keys to reposition it."
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleCropKeys}
          >
            <img
              src={uploadUrl}
              alt=""
              draggable={false}
              onLoad={(event) => setImageSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              style={geometry ? {
                width: geometry.scale * imageSize.width,
                height: geometry.scale * imageSize.height,
                transform: `translate(calc(-50% + ${geometry.x}px), calc(-50% + ${geometry.y}px))`,
              } : undefined}
            />
          </div>
          <label className="avatar-zoom">
            Zoom
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(event) => {
                const nextZoom = Number(event.target.value)
                setZoom(nextZoom)
                if (imageSize) {
                  const next = cropGeometry(
                    imageSize,
                    CROP_SIZE,
                    nextZoom,
                    offset.x,
                    offset.y,
                  )
                  setOffset({ x: next.x, y: next.y })
                }
              }}
            />
          </label>
          <p className="setting-help">Drag to position. Use arrow keys for precise movement.</p>
        </div>
      )}

      {error && <p className="avatar-feedback error" role="alert">{error}</p>}
      {status && <p className="avatar-feedback" role="status" aria-live="polite">{status}</p>}

      <div className="avatar-actions">
        <button type="button" className="avatar-round-action cancel" onClick={onCancel}
          disabled={busy} title="Cancel profile changes" aria-label="Cancel profile changes">
          <Icon name="close" size={22} />
        </button>
        <button
          type="button"
          className="avatar-round-action save"
          onClick={save}
          disabled={busy || (uploadUrl ? !imageSize : choice.type === 'upload')}
          aria-busy={busy}
          title="Save profile"
          aria-label="Save profile"
        >
          <Icon name="checkmark" size={24} />
        </button>
      </div>
    </section>
  )
}

export default function Profile({ onClose, themePreference, onThemeChange }) {
  const { user, logout, changePassword, updateUsername } = useAuth()
  const [avatarExpanded, setAvatarExpanded] = useState(false)
  const [username, setUsername] = useState(user?.username || '')
  const [usernameError, setUsernameError] = useState('')
  const [usernameSaved, setUsernameSaved] = useState(false)
  const [usernameBusy, setUsernameBusy] = useState(false)
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
    && (window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true)
  const notificationHelp = !notificationsSupported
    ? isIos && !isStandalone
      ? 'On iPhone or iPad, add Chrona to the Home Screen and open it there to enable notifications.'
      : 'Web Push is not supported by this browser or device.'
    : Notification.permission === 'denied'
      ? 'Notifications are blocked. Allow them in this device’s browser or app settings, then re-register.'
      : Notification.permission === 'granted'
        ? 'Notifications are allowed on this device.'
        : 'Tap “Send test notification” to request notification permission.'

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      if (avatarExpanded) setAvatarExpanded(false)
      else onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [avatarExpanded, onClose])

  const sendTest = async () => {
    setTestMsg('Sending…')
    try {
      const ok = await subscribePush()
      if (!ok) {
        setTestMsg('Notifications were not allowed or are unavailable on this device.')
        return
      }
      const endpoint = await currentPushEndpoint()
      const response = await api('/api/push/test', {
        method: 'POST',
        body: JSON.stringify({ endpoint }),
      })
      setTestMsg(`Sent to ${response.sent} device(s). Check your notifications.`)
    } catch (sendError) {
      setTestMsg(sendError.message || 'Could not send test.')
    }
  }

  const reregister = async () => {
    setTestMsg('Re-registering…')
    try {
      const ok = await reregisterPush()
      setTestMsg(ok
        ? 'Notifications re-registered. Try "Send test notification".'
        : 'Notifications were not allowed or are unavailable on this device.')
    } catch (registrationError) {
      setTestMsg(registrationError.message || 'Could not re-register.')
    }
  }

  const submitUsername = async (event) => {
    event.preventDefault()
    if (usernameBusy) return
    setUsernameError('')
    setUsernameSaved(false)
    setUsernameBusy(true)
    try {
      const profile = await updateUsername(username)
      setUsername(profile.username)
      setUsernameSaved(true)
    } catch (submitError) {
      setUsernameError(submitError.message)
    } finally {
      setUsernameBusy(false)
    }
  }

  const submitPassword = async (event) => {
    event.preventDefault()
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
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-overlay profile-modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="modal profile-modal" role="dialog" aria-modal="true"
        aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="profile-head">
          <div className="profile-id">
            <button type="button" className="profile-avatar-edit-trigger"
              aria-label="Edit profile icon" aria-expanded={avatarExpanded}
              aria-controls="profile-icon-settings"
              onClick={() => setAvatarExpanded((expanded) => !expanded)}>
              <Avatar user={user} size="medium" />
                <span className="profile-avatar-pencil" aria-hidden="true">
                  <Icon name="edit" size={12} />
                </span>
              </button>
            <div>
              <h2 className="profile-name" id="settings-title">Settings</h2>
              <span className="profile-username">@{user?.username}</span>
            </div>
          </div>
          <IconButton label="Close" name="close" onClick={onClose} />
        </div>

        <div className="profile-form">
          {avatarExpanded && <div id="profile-icon-settings">
            <AvatarEditor user={user} onCancel={() => setAvatarExpanded(false)} />
          </div>}

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
                onClick={sendTest}>Send test notification</button>
              <button type="button" className="logout-btn" disabled={!notificationsSupported}
                onClick={reregister}>Re-register notifications</button>
            </div>
            {testMsg && <p className="auth-success">{testMsg}</p>}
          </section>

          <section className="username-section">
            <h3 className="section-title">Change username</h3>
            <form className="username-change-form" onSubmit={submitUsername}>
              <label className="auth-label" htmlFor="profile-username">Username</label>
              <div>
                <input id="profile-username" className="auth-input" value={username}
                  autoComplete="username" minLength="3" maxLength="32"
                  pattern="[A-Za-z0-9._-]+"
                  onChange={(event) => {
                    setUsername(event.target.value)
                    setUsernameError('')
                    setUsernameSaved(false)
                  }} />
                <button type="submit" className="auth-submit small"
                  disabled={usernameBusy || !username.trim()}
                  title="Save username" aria-label="Save username">
                  <Icon name="checkmark" size={22} />
                </button>
              </div>
            </form>
            {usernameError && <p className="auth-error">{usernameError}</p>}
            {usernameSaved && <p className="auth-success">Username updated.</p>}
          </section>

          <form className="password-change-form" onSubmit={submitPassword}>
            <h3 className="section-title">Change password</h3>
            <label className="auth-label">Current password</label>
            <PasswordField value={currentPassword} onChange={setCurrentPassword}
              placeholder="current password" autoComplete="current-password" />
            <label className="auth-label">New password</label>
            <PasswordField value={newPassword} onChange={setNewPassword}
              placeholder="new password" autoComplete="new-password" />
            <label className="auth-label">Confirm new password</label>
            <PasswordField value={confirm} onChange={setConfirm}
              placeholder="re-enter new password" autoComplete="new-password" />
            {confirm && confirm !== newPassword &&
              <p className="mismatch-msg">Passwords do not match</p>}
            {error && <p className="auth-error">{error}</p>}
            {done && <p className="auth-success">Password updated.</p>}

            <div className="profile-actions">
              <button type="button" className="logout-btn" onClick={logout}>Sign out</button>
              <button type="submit" className="auth-submit small" disabled={busy}
                title="Save new password" aria-label="Save new password">
                <Icon name="checkmark" size={22} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  )
}
