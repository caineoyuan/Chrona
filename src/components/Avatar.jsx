import { useState } from 'react'
import { avatarInkFor, resolvedAvatar } from '../profile-avatar.js'

export default function Avatar({ user, size = 'medium', className = '' }) {
  const avatar = resolvedAvatar(user)
  const [failedUrl, setFailedUrl] = useState(null)
  const classes = `profile-avatar profile-avatar-${size} ${className}`.trim()

  if ((avatar.type === 'bundled' || avatar.type === 'upload') && failedUrl !== avatar.url) {
    return (
      <span className={classes} data-avatar-type={avatar.type}>
        <img src={avatar.url} alt="" draggable={false} onError={() => setFailedUrl(avatar.url)} />
      </span>
    )
  }

  const fallback = avatar.type === 'initial' ? avatar : resolvedAvatar({ ...user, avatar: null })
  return (
    <span
      className={classes}
      data-avatar-type="initial"
      style={{
        '--avatar-color': `#${fallback.color}`,
        '--avatar-ink': avatarInkFor(fallback.color),
      }}
      aria-hidden="true"
    >
      {fallback.initial}
    </span>
  )
}
