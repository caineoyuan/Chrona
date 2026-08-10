export function envFlag(value, fallback = false) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export const features = Object.freeze({
  sharing: envFlag(process.env.SHARING_ENABLED, true),
})

export function featureUnavailable(_request, response) {
  return response.status(404).json({ error: 'Not found.' })
}
