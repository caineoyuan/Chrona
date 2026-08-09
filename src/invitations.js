const INVITE_STORAGE_KEY = 'chrona-pending-invite'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function retainInviteToken(
  location = globalThis.window?.location,
  storage = globalThis.sessionStorage,
  history = globalThis.window?.history,
) {
  if (!location || !storage) return null
  const params = new URLSearchParams(location.search)
  const token = params.get('invite') || params.get('invite_token')
  if (token && TOKEN_PATTERN.test(token)) {
    storage.setItem(INVITE_STORAGE_KEY, token)
    if (location.href && history?.replaceState) {
      const cleanUrl = new URL(location.href)
      cleanUrl.searchParams.delete('invite')
      cleanUrl.searchParams.delete('invite_token')
      history.replaceState(history.state, '', cleanUrl)
    }
  }
  return storage.getItem(INVITE_STORAGE_KEY)
}

export function pendingInviteToken(storage = globalThis.sessionStorage) {
  if (!storage) return null
  const token = storage.getItem(INVITE_STORAGE_KEY)
  return token && TOKEN_PATTERN.test(token) ? token : null
}

export function clearPendingInviteToken(storage = globalThis.sessionStorage) {
  storage?.removeItem(INVITE_STORAGE_KEY)
}

export function invitationClient(request) {
  const call = (path, options) => request(`/api/sharing${path}`, options)
  const invitationPayload = (resourceType, resourceId, permissions) => ({
    resourceType,
    resourceId,
    permissions,
  })
  return {
    inviteUsername(resourceId, username, permissions, resourceType = 'medication_list') {
      return call('/invitations/username', {
        method: 'POST',
        body: JSON.stringify({
          ...invitationPayload(resourceType, resourceId, permissions),
          username,
        }),
      })
    },
    createLink(resourceId, permissions, resourceType = 'medication_list') {
      return call('/invitations/link', {
        method: 'POST',
        body: JSON.stringify(invitationPayload(
          resourceType,
          resourceId,
          permissions,
        )),
      })
    },
    async list() {
      const data = await call('/invitations')
      return Array.isArray(data?.invitations) ? data.invitations : []
    },
    accept(invitationId) {
      return call(`/invitations/${invitationId}/accept`, { method: 'POST' })
    },
    decline(invitationId) {
      return call(`/invitations/${invitationId}/decline`, { method: 'POST' })
    },
    revoke(invitationId) {
      return call(`/invitations/${invitationId}`, { method: 'DELETE' })
    },
  }
}
