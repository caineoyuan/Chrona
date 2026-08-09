export function minimalEventPayload(eventType, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  if (eventType === 'invite' || eventType === 'accepted') {
    return value.inviteId === undefined ? {} : { inviteId: String(value.inviteId) }
  }
  return {}
}
