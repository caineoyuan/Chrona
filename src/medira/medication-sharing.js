import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from '../auth.jsx'
import { invitationClient } from '../invitations.js'
import { medicationResourceClient } from './scoped-medications.js'

export function useMedicationSharing(active) {
  const resource = useRef(medicationResourceClient(api))
  const invitations = useRef(invitationClient(api))
  const [state, setState] = useState({
    status: 'idle',
    members: [],
    invitations: [],
    profiles: [],
    resourceId: '',
    version: null,
    error: '',
    link: '',
  })

  const refresh = useCallback(async () => {
    if (!active || isLocalPreview) return
    setState((current) => ({ ...current, status: 'loading', error: '' }))
    try {
      const [data, profileData] = await Promise.all([
        resource.current.listShares(),
        resource.current.listMedicationLists(),
      ])
      setState((current) => ({
        ...current,
        status: 'ready',
        members: data.members || [],
        invitations: data.invitations || [],
        profiles: profileData.lists || [],
        resourceId: data.resourceId,
        version: data.version,
        error: '',
      }))
    } catch (error) {
      setState((current) => ({ ...current, status: 'error', error: error.message }))
    }
  }, [active])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = useCallback(async (work, success) => {
    setState((current) => ({ ...current, status: 'busy', error: '' }))
    try {
      const result = await work()
      await refresh()
      setState((current) => ({ ...current, status: 'ready', ...success(result) }))
      return result
    } catch (error) {
      if (error.status === 409) {
        await refresh()
        setState((current) => ({
          ...current,
          status: 'error',
          error: 'Sharing changed elsewhere. Reloaded the latest access list.',
        }))
      } else {
        setState((current) => ({
          ...current,
          status: 'error',
          error: error.message,
        }))
      }
      throw error
    }
  }, [refresh])

  return {
    ...state,
    refresh,
    inviteUsername: (username, permissions) => run(
      () => invitations.current.inviteUsername(
        state.resourceId,
        username,
        permissions,
        'medication_list',
      ),
      () => ({ link: '' }),
    ),
    createLink: (permissions) => run(
      () => invitations.current.createLink(
        state.resourceId,
        permissions,
        'medication_list',
      ),
      (result) => ({
        link: new URL(result.invitePath, window.location.origin).toString(),
      }),
    ),
    revokeInvitation: (id) => run(
      () => invitations.current.revoke(id),
      () => ({ link: '' }),
    ),
    revokeMember: (userId) => run(
      () => resource.current.revokeShare(
        userId,
        state.version,
      ),
      () => ({ link: '' }),
    ),
  }
}
