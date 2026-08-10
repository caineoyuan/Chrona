import { AddFilled } from '@fluentui/react-icons/svg/add'
import { AppsListRegular } from '@fluentui/react-icons/svg/apps-list'
import { BoxRegular } from '@fluentui/react-icons/svg/box'
import { CameraRegular } from '@fluentui/react-icons/svg/camera'
import { ChevronDownRegular } from '@fluentui/react-icons/svg/chevron-down'
import { ChevronUpRegular } from '@fluentui/react-icons/svg/chevron-up'
import { CheckmarkFilled } from '@fluentui/react-icons/svg/checkmark'
import { ClockRegular } from '@fluentui/react-icons/svg/clock'
import { DismissRegular } from '@fluentui/react-icons/svg/dismiss'
import { PlayRegular } from '@fluentui/react-icons/svg/play'
import { SearchRegular } from '@fluentui/react-icons/svg/search'
import { SaveRegular } from '@fluentui/react-icons/svg/save'
import Icon from './Icon.jsx'

const SHARED_GLYPHS = new Set([
  'copy',
  'edit',
  'link',
  'trash',
  'user-add',
])

const FLUENT_GLYPHS = {
  plus: AddFilled,
  check: CheckmarkFilled,
  clock: ClockRegular,
  close: DismissRegular,
  camera: CameraRegular,
  play: PlayRegular,
  box: BoxRegular,
  list: AppsListRegular,
  search: SearchRegular,
  save: SaveRegular,
  chevron: ChevronDownRegular,
  'chevron-down': ChevronDownRegular,
  'chevron-up': ChevronUpRegular,
}

export default function PaperIcon({ name, size = 20, className = '' }) {
  if (name === 'pill' || name === 'syringe') {
    return (
      <img
        className={`medication-icon ${className}`.trim()}
        src={name === 'syringe' ? '/syringe-icon.svg' : '/medication-icon.png'}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
      />
    )
  }
  if (SHARED_GLYPHS.has(name)) {
    return <Icon name={name} size={size} className={`icon action-glyph ${className}`.trim()} />
  }
  if (name === 'pause') {
    return (
      <svg
        className={`icon action-glyph ${className}`.trim()}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <rect x="5" y="3" width="5" height="18" rx="1" fill="currentColor" />
        <rect x="14" y="3" width="5" height="18" rx="1" fill="currentColor" />
      </svg>
    )
  }
  const FluentIcon = FLUENT_GLYPHS[name]
  return FluentIcon
    ? <FluentIcon className={`icon ${className}`.trim()} fontSize={size} aria-hidden="true" />
    : null
}
