import Icon from './Icon.jsx'
import { CheckmarkFilled } from '@fluentui/react-icons/svg/checkmark'

export function IconButton({
  label,
  name,
  icon,
  iconSize = 20,
  iconClassName = '',
  variant = 'icon',
  className = '',
  ...props
}) {
  const baseClass = variant === 'swipe' ? 'swipe-act' : 'icon-btn'
  return (
    <button
      type="button"
      className={`${baseClass} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {icon || <Icon name={name} size={iconSize} className={iconClassName} />}
    </button>
  )
}

export function CheckCircleButton({
  label,
  complete = false,
  icon,
  onChange,
  className = '',
  ...props
}) {
  return (
    <button
      type="button"
      className={`taken-toggle ${complete ? 'complete' : ''} ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={complete}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onChange?.(!complete)
      }}
      {...props}
    >
      {icon || <CheckmarkFilled className="icon" fontSize={20} aria-hidden="true" />}
    </button>
  )
}
