import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from './db.js'

const COOKIE_NAME = 'chrona_token'
const BCRYPT_ROUNDS = 12
const REMEMBER_DAYS = 30
const SESSION_DAYS = 1

function jwtSecret() {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET is not configured')
  return s
}

function isProd() {
  return process.env.NODE_ENV === 'production'
}

function signToken(userId, days) {
  return jwt.sign({ uid: userId }, jwtSecret(), { expiresIn: `${days}d` })
}

function setAuthCookie(res, token, remember) {
  const maxAge = (remember ? REMEMBER_DAYS : SESSION_DAYS) * 24 * 60 * 60 * 1000
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    maxAge,
    path: '/',
  })
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

// Express middleware: require a valid auth cookie, attach req.userId.
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  try {
    const payload = jwt.verify(token, jwtSecret())
    req.userId = payload.uid
    next()
  } catch {
    clearAuthCookie(res)
    return res.status(401).json({ error: 'Session expired' })
  }
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validateUsername(username) {
  if (!username) return 'Username is required.'
  if (username.length < 3 || username.length > 32)
    return 'Username must be 3–32 characters.'
  if (!/^[a-z0-9._-]+$/.test(username))
    return 'Username may only contain letters, numbers, and . _ -'
  return null
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8)
    return 'Password must be at least 8 characters.'
  if (password.length > 200) return 'Password is too long.'
  return null
}

const router = Router()

router.post('/register', async (req, res) => {
  try {
    const { password, confirm, key } = req.body || {}
    const username = normalizeUsername(req.body?.username)

    const expectedKey = process.env.REGISTRATION_KEY
    if (!expectedKey) {
      return res
        .status(503)
        .json({ error: 'Registration is not configured on this server.' })
    }
    if (typeof key !== 'string' || key !== expectedKey) {
      return res.status(403).json({ error: 'Invalid registration key.' })
    }

    const uErr = validateUsername(username)
    if (uErr) return res.status(400).json({ error: uErr })
    const pErr = validatePassword(password)
    if (pErr) return res.status(400).json({ error: pErr })
    if (password !== confirm)
      return res.status(400).json({ error: 'Passwords do not match.' })

    const existing = await query('SELECT 1 FROM users WHERE username = $1', [username])
    if (existing.rowCount > 0)
      return res.status(409).json({ error: 'That username is already taken.' })

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const inserted = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash],
    )
    const userId = inserted.rows[0].id
    await query('INSERT INTO user_sets (user_id, sets) VALUES ($1, $2)', [
      userId,
      JSON.stringify([]),
    ])

    const token = signToken(userId, SESSION_DAYS)
    setAuthCookie(res, token, false)
    return res.status(201).json({ username })
  } catch (err) {
    console.error('register error', err)
    return res.status(500).json({ error: 'Could not create account.' })
  }
})

router.post('/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username)
    const { password, remember } = req.body || {}

    const result = await query(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username],
    )
    const user = result.rows[0]
    // Always run a compare to reduce timing/user-enumeration differences.
    const hash = user?.password_hash || '$2a$12$0000000000000000000000000000000000000000000000000000'
    const ok = await bcrypt.compare(typeof password === 'string' ? password : '', hash)
    if (!user || !ok)
      return res.status(401).json({ error: 'Invalid username or password.' })

    const rememberMe = Boolean(remember)
    const token = signToken(user.id, rememberMe ? REMEMBER_DAYS : SESSION_DAYS)
    setAuthCookie(res, token, rememberMe)
    return res.json({ username })
  } catch (err) {
    console.error('login error', err)
    return res.status(500).json({ error: 'Could not sign in.' })
  }
})

router.post('/logout', (req, res) => {
  clearAuthCookie(res)
  res.json({ ok: true })
})

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT username FROM users WHERE id = $1', [req.userId])
    const user = result.rows[0]
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    res.json({ username: user.username })
  } catch (err) {
    console.error('me error', err)
    res.status(500).json({ error: 'Could not load account.' })
  }
})

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirm } = req.body || {}

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [
      req.userId,
    ])
    const user = result.rows[0]
    if (!user) return res.status(401).json({ error: 'Not authenticated' })

    const ok = await bcrypt.compare(
      typeof currentPassword === 'string' ? currentPassword : '',
      user.password_hash,
    )
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect.' })

    const pErr = validatePassword(newPassword)
    if (pErr) return res.status(400).json({ error: pErr })
    if (newPassword !== confirm)
      return res.status(400).json({ error: 'New passwords do not match.' })

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId])
    res.json({ ok: true })
  } catch (err) {
    console.error('change-password error', err)
    res.status(500).json({ error: 'Could not update password.' })
  }
})

export default router
