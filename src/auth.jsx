import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const AuthContext = createContext(null)

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
    throw new Error(message)
  }
  return data
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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

  const login = useCallback(async (username, password, remember) => {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, remember }),
    })
    setUser(data)
    return data
  }, [])

  const register = useCallback(async (payload) => {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
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

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, logout, changePassword }}
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
