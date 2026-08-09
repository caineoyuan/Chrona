import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import {
  clearPendingInviteToken,
  pendingInviteToken,
  retainInviteToken,
} from './invitations.js'
import { sharingEnabled } from './feature-flags.js'

const AuthContext = createContext(null)

export const isLocalPreview =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  new URLSearchParams(window.location.search).has('preview')

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const message = data?.error || 'Something went wrong. Please try again.'
    const error = new Error(message)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

export function AuthProvider({ children }) {
  const [inviteToken, setInviteToken] = useState(
    () => isLocalPreview || !sharingEnabled ? null : retainInviteToken(),
  )
  const [user, setUser] = useState(
    isLocalPreview
      ? { username: 'Preview', displayUsername: 'Preview', timezone: 'UTC' }
      : null,
  )
  const [loading, setLoading] = useState(!isLocalPreview)

  useEffect(() => {
    if (isLocalPreview) return
    let active = true
    api('/api/auth/me')
      .then((data) => {
        if (active) setUser(data)
      })
      .catch(() => {
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!user || isLocalPreview || !sharingEnabled) return
    const token = inviteToken || pendingInviteToken()
    if (!token) return
    api('/api/sharing/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then(() => {
        clearPendingInviteToken()
        setInviteToken(null)
        window.dispatchEvent(new CustomEvent('chrona:invite-accepted'))
      })
      .catch((error) => console.error('Could not accept invitation:', error))
  }, [inviteToken, user])

  const login = useCallback(async (username, password, remember) => {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, remember }),
    })
    setUser(data)
    return data
  }, [])

  const register = useCallback(async (payload) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ ...payload, timezone }),
    })
    setUser(data)
    return data
  }, [])

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])

  const changePassword = useCallback(async (payload) => {
    return api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }, [])

  const updateTimezone = useCallback(async (timezone) => {
    const data = await api('/api/auth/profile/timezone', {
      method: 'PUT',
      body: JSON.stringify({ timezone }),
    })
    setUser(data)
    return data
  }, [])

  const updateUsername = useCallback(async (username) => {
    const data = await api('/api/auth/profile/username', {
      method: 'PUT',
      body: JSON.stringify({ username }),
    })
    setUser(data)
    return data
  }, [])

  const updateAvatarChoice = useCallback(async (avatar) => {
    const data = await api('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ avatar }),
    })
    setUser(data)
    return data
  }, [])

  const uploadAvatar = useCallback(async (blob) => {
    const response = await fetch('/api/profile/avatar', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(data?.error || 'Could not upload profile image.')
    }
    const next = {
      ...data,
      avatar: {
        ...data.avatar,
        url: `${data.avatar.url}?v=${Date.now()}`,
      },
    }
    setUser(next)
    return next
  }, [])

  const resetAvatar = useCallback(async () => {
    const data = await api('/api/profile/avatar', { method: 'DELETE' })
    setUser(data)
    return data
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        changePassword,
        updateUsername,
        updateTimezone,
        updateAvatarChoice,
        uploadAvatar,
        resetAvatar,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

export { api }
