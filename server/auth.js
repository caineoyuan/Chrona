import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from './db.js'
import {
  PROFILE_COLUMNS,
  profileFromRow,
} from './profile.js'

const COOKIE_NAME = 'chrona_token'
const BCRYPT_ROUNDS = 12
const REMEMBER_DAYS = 30
const SESSION_DAYS = 1
const DUMMY_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000'

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

export function normalizeTimezone(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.length > 100) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
      .timeZone
  } catch {
    return null
  }
}

export { profileFromRow }

export function createAuthRouter(queryFn = query) {
  const router = Router()

  router.post('/register', async (req, res) => {
    try {
      const { password, confirm, key } = req.body || {}
      const username = normalizeUsername(req.body?.username)
      const timezone = normalizeTimezone(req.body?.timezone, 'UTC')

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
      if (!timezone) return res.status(400).json({ error: 'Invalid IANA timezone.' })

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      const inserted = await queryFn(
        `WITH new_user AS (
           INSERT INTO users (
             username, password_hash, display_username, timezone, status, updated_at
           )
           VALUES ($1, $2, $1, $3, 'active', now())
           RETURNING ${PROFILE_COLUMNS}
         ), new_identity AS (
           INSERT INTO user_identities (
             user_id, provider, provider_subject, password_hash
           )
           SELECT id, 'local', $1, $2 FROM new_user
         ), new_sets AS (
           INSERT INTO user_sets (user_id, sets)
           SELECT id, '[]'::jsonb FROM new_user
         ), new_medications AS (
           INSERT INTO user_medications (user_id, medications)
           SELECT id, '[]'::jsonb FROM new_user
         ), new_medication_list AS (
           INSERT INTO medication_lists (owner_user_id)
           SELECT id FROM new_user
         )
         SELECT ${PROFILE_COLUMNS} FROM new_user`,
        [username, passwordHash, timezone],
      )
      const user = inserted.rows[0]

      const token = signToken(user.id, SESSION_DAYS)
      setAuthCookie(res, token, false)
      return res.status(201).json(profileFromRow(user))
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'That username is already taken.' })
      }
      console.error('register error', err)
      return res.status(500).json({ error: 'Could not create account.' })
    }
  })

  router.post('/login', async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username)
      const { password, remember } = req.body || {}

      const result = await queryFn(
        `SELECT u.id, u.username, u.display_username, u.timezone, u.status,
                u.avatar_kind, u.avatar_value, u.avatar_color, u.avatar_file,
                identity.id AS identity_id,
                COALESCE(identity.password_hash, u.password_hash) AS password_hash
         FROM users u
         LEFT JOIN user_identities identity
           ON identity.user_id = u.id AND identity.provider = 'local'
         WHERE identity.provider_subject = $1
            OR (identity.id IS NULL AND lower(u.username) = $1)
         LIMIT 1`,
        [username],
      )
      const user = result.rows[0]
      const ok = await bcrypt.compare(
        typeof password === 'string' ? password : '',
        user?.password_hash || DUMMY_HASH,
      )
      if (!user || !ok || user.status !== 'active')
        return res.status(401).json({ error: 'Invalid username or password.' })

      await queryFn(
        `INSERT INTO user_identities (
           user_id, provider, provider_subject, password_hash, last_login_at
         )
         VALUES ($1, 'local', $2, $3, now())
         ON CONFLICT (user_id, provider) DO UPDATE
         SET provider_subject = EXCLUDED.provider_subject,
             password_hash = EXCLUDED.password_hash,
             last_login_at = EXCLUDED.last_login_at`,
        [user.id, username, user.password_hash],
      )

      const rememberMe = Boolean(remember)
      const token = signToken(user.id, rememberMe ? REMEMBER_DAYS : SESSION_DAYS)
      setAuthCookie(res, token, rememberMe)
      return res.json(profileFromRow(user))
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
      const result = await queryFn(
        `SELECT ${PROFILE_COLUMNS} FROM users
         WHERE id = $1 AND status = 'active'`,
        [req.userId],
      )
      const user = result.rows[0]
      if (!user) return res.status(401).json({ error: 'Not authenticated' })
      res.json(profileFromRow(user))
    } catch (err) {
      console.error('me error', err)
      res.status(500).json({ error: 'Could not load account.' })
    }
  })

  const updateTimezone = async (req, res) => {
    try {
      const timezone = normalizeTimezone(req.body?.timezone)
      if (!timezone) return res.status(400).json({ error: 'Invalid IANA timezone.' })
      const result = await queryFn(
        `UPDATE users SET timezone = $1, updated_at = now()
         WHERE id = $2 AND status = 'active'
         RETURNING ${PROFILE_COLUMNS}`,
        [timezone, req.userId],
      )
      const user = result.rows[0]
      if (!user) return res.status(401).json({ error: 'Not authenticated' })
      return res.json(profileFromRow(user))
    } catch (err) {
      console.error('timezone update error', err)
      return res.status(500).json({ error: 'Could not update timezone.' })
    }
  }

  router.put('/profile/timezone', requireAuth, updateTimezone)
  router.patch('/profile/timezone', requireAuth, updateTimezone)

  const updateUsername = async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username)
      const usernameError = validateUsername(username)
      if (usernameError) return res.status(400).json({ error: usernameError })
      const result = await queryFn(
        `WITH updated_user AS (
           UPDATE users
           SET username = $1, display_username = $1, updated_at = now()
           WHERE id = $2 AND status = 'active'
           RETURNING ${PROFILE_COLUMNS}
         ), updated_identity AS (
           UPDATE user_identities
           SET provider_subject = $1
           WHERE user_id = $2 AND provider = 'local'
         )
         SELECT ${PROFILE_COLUMNS} FROM updated_user`,
        [username, req.userId],
      )
      const user = result.rows[0]
      if (!user) return res.status(401).json({ error: 'Not authenticated' })
      return res.json(profileFromRow(user))
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'That username is already taken.' })
      }
      console.error('username update error', err)
      return res.status(500).json({ error: 'Could not update username.' })
    }
  }

  router.put('/profile/username', requireAuth, updateUsername)
  router.patch('/profile/username', requireAuth, updateUsername)

  router.post('/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword, confirm } = req.body || {}

      const result = await queryFn(
        `SELECT u.username,
                COALESCE(identity.password_hash, u.password_hash) AS password_hash
         FROM users u
         LEFT JOIN user_identities identity
           ON identity.user_id = u.id AND identity.provider = 'local'
         WHERE u.id = $1 AND u.status = 'active'`,
        [req.userId],
      )
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
      await queryFn(
        `WITH updated_user AS (
           UPDATE users SET password_hash = $1, updated_at = now()
           WHERE id = $2
           RETURNING id, lower(username) AS provider_subject
         )
         INSERT INTO user_identities (
           user_id, provider, provider_subject, password_hash
         )
         SELECT id, 'local', provider_subject, $1 FROM updated_user
         ON CONFLICT (user_id, provider) DO UPDATE
         SET password_hash = EXCLUDED.password_hash`,
        [newHash, req.userId],
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('change-password error', err)
      res.status(500).json({ error: 'Could not update password.' })
    }
  })

  return router
}

export default createAuthRouter()
