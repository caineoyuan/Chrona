import { useState } from 'react'
import Icon from './Icon.jsx'
import { useAuth } from '../auth.jsx'

function PasswordField({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false)
  return (
    <div className="password-field">
      <input
        className="auth-input"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className={`eye-btn ${show ? 'on' : ''}`}
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide password' : 'Show password'}
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        <Icon name="eye" size={20} />
      </button>
    </div>
  )
}

export default function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [key, setKey] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setPassword('')
    setConfirm('')
    setKey('')
    setError('')
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(username, password, remember)
      } else {
        await register({ username, password, confirm, key })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Icon name="timer" size={40} className="brand-mark" />
          <h1 className="auth-title">Chrona</h1>
        </div>

        <label className="auth-label">Username</label>
        <input
          className="auth-input"
          type="text"
          value={username}
          placeholder="username"
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />

        <label className="auth-label">Password</label>
        <PasswordField
          value={password}
          onChange={setPassword}
          placeholder="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />

        {mode === 'register' && (
          <>
            <label className="auth-label">Confirm password</label>
            <PasswordField
              value={confirm}
              onChange={setConfirm}
              placeholder="re-enter password"
              autoComplete="new-password"
            />
            {confirm && confirm !== password && (
              <p className="mismatch-msg">Passwords do not match</p>
            )}

            <label className="auth-label">Registration key</label>
            <PasswordField
              value={key}
              onChange={setKey}
              placeholder="registration key"
              autoComplete="off"
            />
          </>
        )}

        {mode === 'login' && (
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember me for 30 days</span>
          </label>
        )}

        {error && <p className="auth-error">{error}</p>}

        <div className="auth-submit-row">
          {mode === 'login' ? (
            <button
              type="button"
              className="auth-secondary"
              onClick={() => {
                setMode('register')
                reset()
              }}
              title="Create account"
              aria-label="Create account"
            >
              <Icon name="plus" size={24} />
            </button>
          ) : (
            <button
              type="button"
              className="auth-secondary"
              onClick={() => {
                setMode('login')
                reset()
              }}
              title="Back to sign in"
              aria-label="Back to sign in"
            >
              <Icon name="arrow-left" size={24} />
            </button>
          )}
          <button
            type="submit"
            className="auth-submit"
            disabled={busy}
            title={mode === 'login' ? 'Sign in' : 'Create account'}
            aria-label={mode === 'login' ? 'Sign in' : 'Create account'}
          >
            <Icon name="arrow-right" size={26} />
          </button>
        </div>
      </form>
    </div>
  )
}
