export const AVATAR_COLORS = Object.freeze([
  '52AA8A',
  '52AA5E',
  '388659',
  'E26D5C',
  'FDB833',
  '1789FC',
  '4A5759',
  'F26157',
  'EF7B45',
  '5EB1BF',
  '94DDBC',
  '136F63',
  '465362',
])

function stableHash(value) {
  let hash = 2166136261
  for (const character of String(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function defaultAvatarFor(user = {}) {
  const label = String(user.displayUsername || user.username || '?').trim()
  const initial = label.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() || '?'
  const key = user.id ?? user.username ?? label
  return {
    type: 'initial',
    initial,
    color: AVATAR_COLORS[stableHash(key) % AVATAR_COLORS.length],
  }
}

export function resolvedAvatar(user = {}) {
  return user.avatar || defaultAvatarFor(user)
}

export function avatarInkFor(color) {
  return ['4A5759', '136F63', '465362'].includes(color) ? '#f0f0ed' : '#151515'
}

export function cropGeometry(image, viewportSize, zoom, offsetX, offsetY) {
  const coverScale = Math.max(viewportSize / image.width, viewportSize / image.height)
  const scale = coverScale * zoom
  const renderedWidth = image.width * scale
  const renderedHeight = image.height * scale
  const maxX = Math.max(0, (renderedWidth - viewportSize) / 2)
  const maxY = Math.max(0, (renderedHeight - viewportSize) / 2)
  const x = Math.max(-maxX, Math.min(maxX, offsetX))
  const y = Math.max(-maxY, Math.min(maxY, offsetY))
  return {
    scale,
    x,
    y,
    sourceX: (renderedWidth / 2 - viewportSize / 2 - x) / scale,
    sourceY: (renderedHeight / 2 - viewportSize / 2 - y) / scale,
    sourceSize: viewportSize / scale,
  }
}
