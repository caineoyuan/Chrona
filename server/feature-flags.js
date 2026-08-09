export function envFlag(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(
    value.trim().toLowerCase(),
  )
}

export const features = Object.freeze({
  sharing: envFlag(process.env.SHARING_ENABLED),
})

export function featureUnavailable(_request, response) {
  return response.status(404).json({ error: 'Not found.' })
}
