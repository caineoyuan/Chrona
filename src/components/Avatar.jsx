import { avatarInkFor, resolvedAvatar } from '../profile-avatar.js'

export default function Avatar({ user, size = 'medium', className = '' }) {
  const avatar = resolvedAvatar(user)
  const classes = `profile-avatar profile-avatar-${size} ${className}`.trim()

  if (avatar.type === 'bundled' || avatar.type === 'upload') {
    return (
      <span className={classes} data-avatar-type={avatar.type}>
        <img src={avatar.url} alt="" draggable={false} />
      </span>
    )
  }

  return (
    <span
      className={classes}
      data-avatar-type="initial"
      style={{
        '--avatar-color': `#${avatar.color}`,
        '--avatar-ink': avatarInkFor(avatar.color),
      }}
      aria-hidden="true"
    >
      {avatar.initial}
    </span>
  )
}
