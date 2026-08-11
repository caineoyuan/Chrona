import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router } from 'express'
import sharp from 'sharp'
import avatarManifest from '../public/avatars/manifest.json' with { type: 'json' }
import { query } from './db.js'

export const AVATAR_COLORS = Object.freeze([
  '52AA8A',
  '52AA5E',
  '388659',
  'E26D5C',
  'FDB833',
  '1789FC',
  '4A5759',
  'F26157',
  'EF7B45',
  '5EB1BF',
  '94DDBC',
  '136F63',
  '465362',
])

export const PROFILE_COLUMNS =
  'id, username, display_username, timezone, avatar_kind, avatar_value, avatar_color, avatar_file'

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024
export const MAX_AVATAR_DIMENSION = 4096
export const NORMALIZED_AVATAR_SIZE = 256

const avatarIds = new Set(avatarManifest.avatars.map(({ id }) => id))
const avatarFiles = new Map(avatarManifest.avatars.map(({ id, file }) => [id, file]))
const defaultAvatarDirectory = fileURLToPath(new URL('../data/profile-avatars/', import.meta.url))

export class ProfileValidationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function stableHash(value) {
  let hash = 2166136261
  for (const character of String(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function defaultAvatarFor(user) {
  const label = String(user.display_username || user.username || '?').trim()
  const initial = label.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() || '?'
  const key = user.id ?? user.username ?? label
  return {
    type: 'initial',
    initial,
    color: AVATAR_COLORS[stableHash(key) % AVATAR_COLORS.length],
  }
}

export function normalizeAvatarColor(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^#/, '').toUpperCase()
  return AVATAR_COLORS.includes(normalized) ? normalized : null
}

export function profileFromRow(user) {
  let avatar = defaultAvatarFor(user)
  if (user.avatar_kind === 'initial' && user.avatar_color) {
    avatar = { ...avatar, color: user.avatar_color }
  } else if (user.avatar_kind === 'bundled' && avatarIds.has(user.avatar_value)) {
    avatar = {
      type: 'bundled',
      id: user.avatar_value,
      url: `${avatarManifest.basePath}${avatarFiles.get(user.avatar_value)}`,
    }
  } else if (user.avatar_kind === 'upload' && user.avatar_file) {
    avatar = {
      type: 'upload',
      url: `/api/profile/avatar/${user.id}`,
    }
  }

  return {
    id: user.id,
    username: user.username,
    displayUsername: user.display_username || user.username,
    timezone: user.timezone,
    avatar,
  }
}

function avatarDirectory(directory) {
  return path.resolve(directory || process.env.PROFILE_AVATAR_DIR || defaultAvatarDirectory)
}

function storedAvatarPath(directory, filename) {
  if (typeof filename !== 'string' || !/^[0-9a-f-]+\.webp$/.test(filename)) return null
  const root = avatarDirectory(directory)
  const candidate = path.resolve(root, filename)
  return path.dirname(candidate) === root ? candidate : null
}

async function removeStoredAvatar(directory, filename) {
  const target = storedAvatarPath(directory, filename)
  if (!target) return
  await fs.rm(target, { force: true }).catch((error) => {
    console.error('avatar cleanup error', error)
  })
}

function suppliedImageType(contentType, bytes) {
  if (contentType === 'image/png') {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png'
      : null
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpeg'
      : null
  }
  if (contentType === 'image/webp') {
    return bytes.length >= 12
      && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP'
      ? 'webp'
      : null
  }
  return null
}

export async function normalizeUploadedAvatar(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ProfileValidationError('An image file is required.')
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new ProfileValidationError('Avatar image must be 5 MB or smaller.', 413)
  }
  const expectedFormat = suppliedImageType(contentType, bytes)
  if (!expectedFormat) {
    throw new ProfileValidationError(
      'Avatar must be a valid PNG, JPEG, or WebP image. SVG uploads are not allowed.',
      415,
    )
  }

  try {
    const image = sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_AVATAR_DIMENSION * MAX_AVATAR_DIMENSION,
    })
    const metadata = await image.metadata()
    if (
      metadata.format !== expectedFormat
      || !metadata.width
      || !metadata.height
      || metadata.width > MAX_AVATAR_DIMENSION
      || metadata.height > MAX_AVATAR_DIMENSION
      || (metadata.pages || 1) !== 1
    ) {
      throw new ProfileValidationError(
        `Avatar dimensions must be between 1 and ${MAX_AVATAR_DIMENSION} pixels and the image must not be animated.`,
      )
    }
    return await image
      .rotate()
      .resize(NORMALIZED_AVATAR_SIZE, NORMALIZED_AVATAR_SIZE, {
        fit: 'cover',
        position: 'centre',
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()
  } catch (error) {
    if (error instanceof ProfileValidationError) throw error
    throw new ProfileValidationError('The uploaded avatar is not a valid or safe image.')
  }
}

function parseAvatarChoice(body) {
  const avatar = body?.avatar ?? body
  if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) {
    throw new ProfileValidationError('Avatar settings are required.')
  }
  if (avatar.type === 'initial') {
    const color = normalizeAvatarColor(avatar.color)
    if (!color) {
      throw new ProfileValidationError(
        `Avatar color must be one of: ${AVATAR_COLORS.join(', ')}.`,
      )
    }
    return { kind: 'initial', value: null, color }
  }
  if (avatar.type === 'bundled') {
    if (typeof avatar.id !== 'string' || !avatarIds.has(avatar.id)) {
      throw new ProfileValidationError('Unknown bundled avatar id.')
    }
    return { kind: 'bundled', value: avatar.id, color: null }
  }
  throw new ProfileValidationError('Avatar type must be "initial" or "bundled".')
}

function handleError(res, error, fallback) {
  if (error instanceof ProfileValidationError) {
    return res.status(error.status).json({ error: error.message })
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Avatar image must be 5 MB or smaller.' })
  }
  console.error(fallback, error)
  return res.status(500).json({ error: 'Could not update profile avatar.' })
}

export function createProfileRouter({
  queryFn = query,
  requireAuth,
  uploadDirectory,
} = {}) {
  if (typeof requireAuth !== 'function') {
    throw new TypeError('createProfileRouter requires authentication middleware')
  }
  const router = Router()

  router.get('/', requireAuth, async (req, res) => {
    try {
      const result = await queryFn(
        `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1 AND status = 'active'`,
        [req.userId],
      )
      if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found.' })
      return res.json(profileFromRow(result.rows[0]))
    } catch (error) {
      console.error('profile load error', error)
      return res.status(500).json({ error: 'Could not load profile.' })
    }
  })

  router.patch('/', requireAuth, async (req, res) => {
    try {
      const choice = parseAvatarChoice(req.body)
      const result = await queryFn(
        `WITH previous AS (
           SELECT avatar_file FROM users WHERE id = $4 AND status = 'active'
         ), updated AS (
           UPDATE users AS target
           SET avatar_kind = $1, avatar_value = $2, avatar_color = $3,
               avatar_file = NULL, avatar_data = NULL, updated_at = now()
           FROM previous
           WHERE target.id = $4 AND target.status = 'active'
           RETURNING target.id, target.username, target.display_username,
                     target.timezone, target.avatar_kind, target.avatar_value,
                     target.avatar_color, target.avatar_file
         )
         SELECT updated.*, previous.avatar_file AS replaced_avatar_file
         FROM updated CROSS JOIN previous`,
        [choice.kind, choice.value, choice.color, req.userId],
      )
      const user = result.rows[0]
      if (!user) return res.status(404).json({ error: 'Profile not found.' })
      await removeStoredAvatar(uploadDirectory, user.replaced_avatar_file)
      return res.json(profileFromRow(user))
    } catch (error) {
      return handleError(res, error, 'avatar choice error')
    }
  })

  router.put(
    '/avatar',
    requireAuth,
    expressRawAvatar(),
    async (req, res) => {
      let filename
      let temporaryPath
      try {
        const contentType = String(req.headers['content-type'] || '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase()
        const normalized = await normalizeUploadedAvatar(req.body, contentType)
        const directory = avatarDirectory(uploadDirectory)
        await fs.mkdir(directory, { recursive: true })
        filename = `${randomUUID()}.webp`
        const finalPath = storedAvatarPath(directory, filename)
        temporaryPath = `${finalPath}.tmp`
        await fs.writeFile(temporaryPath, normalized, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporaryPath, finalPath)
        temporaryPath = null

        const result = await queryFn(
          `WITH previous AS (
             SELECT avatar_file FROM users WHERE id = $3 AND status = 'active'
           ), updated AS (
             UPDATE users AS target
             SET avatar_kind = 'upload', avatar_value = NULL, avatar_color = NULL,
                 avatar_file = $1, avatar_data = $2, updated_at = now()
             FROM previous
             WHERE target.id = $3 AND target.status = 'active'
             RETURNING target.id, target.username, target.display_username,
                       target.timezone, target.avatar_kind, target.avatar_value,
                       target.avatar_color, target.avatar_file
           )
           SELECT updated.*, previous.avatar_file AS replaced_avatar_file
           FROM updated CROSS JOIN previous`,
          [filename, normalized, req.userId],
        )
        const user = result.rows[0]
        if (!user) {
          await removeStoredAvatar(directory, filename)
          return res.status(404).json({ error: 'Profile not found.' })
        }
        if (user.replaced_avatar_file !== filename) {
          await removeStoredAvatar(directory, user.replaced_avatar_file)
        }
        return res.json(profileFromRow(user))
      } catch (error) {
        if (temporaryPath) await fs.rm(temporaryPath, { force: true })
        if (filename) await removeStoredAvatar(uploadDirectory, filename)
        return handleError(res, error, 'avatar upload error')
      }
    },
  )

  router.delete('/avatar', requireAuth, async (req, res) => {
    try {
      const result = await queryFn(
        `WITH previous AS (
           SELECT avatar_file FROM users WHERE id = $1 AND status = 'active'
         ), updated AS (
           UPDATE users AS target
           SET avatar_kind = NULL, avatar_value = NULL, avatar_color = NULL,
               avatar_file = NULL, avatar_data = NULL, updated_at = now()
           FROM previous
           WHERE target.id = $1 AND target.status = 'active'
           RETURNING target.id, target.username, target.display_username,
                     target.timezone, target.avatar_kind, target.avatar_value,
                     target.avatar_color, target.avatar_file
         )
         SELECT updated.*, previous.avatar_file AS replaced_avatar_file
         FROM updated CROSS JOIN previous`,
        [req.userId],
      )
      const user = result.rows[0]
      if (!user) return res.status(404).json({ error: 'Profile not found.' })
      await removeStoredAvatar(uploadDirectory, user.replaced_avatar_file)
      return res.json(profileFromRow(user))
    } catch (error) {
      return handleError(res, error, 'avatar removal error')
    }
  })

  router.get('/avatar/:userId', requireAuth, async (req, res) => {
    if (!/^\d+$/.test(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user id.' })
    }
    try {
      const result = await queryFn(
        `SELECT avatar_file, avatar_data FROM users
         WHERE id = $1 AND status = 'active' AND avatar_kind = 'upload'`,
        [Number(req.params.userId)],
      )
      const stored = result.rows[0]
      if (stored?.avatar_data) {
        res.set('Cache-Control', 'private, max-age=3600')
        res.type('image/webp')
        return res.send(stored.avatar_data)
      }
      const target = storedAvatarPath(uploadDirectory, stored?.avatar_file)
      if (!target) return res.status(404).json({ error: 'Avatar not found.' })
      await fs.access(target)
      res.set('Cache-Control', 'private, max-age=3600')
      res.type('image/webp')
      return res.sendFile(target)
    } catch (error) {
      if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Avatar not found.' })
      console.error('avatar read error', error)
      return res.status(500).json({ error: 'Could not load avatar.' })
    }
  })

  return router
}

function expressRawAvatar() {
  const raw = Router()
  raw.use((req, res, next) => {
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
      return res.status(415).json({
        error: 'Avatar must be a PNG, JPEG, or WebP image. SVG uploads are not allowed.',
      })
    }
    const contentLength = Number(req.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
      return res.status(413).json({ error: 'Avatar image must be 5 MB or smaller.' })
    }
    return next()
  })
  raw.use((awaitImportExpressRaw()) )
  return raw
}

function awaitImportExpressRaw() {
  return (req, res, next) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total <= MAX_AVATAR_BYTES) chunks.push(chunk)
    })
    req.on('end', () => {
      if (total > MAX_AVATAR_BYTES) {
        return res.status(413).json({ error: 'Avatar image must be 5 MB or smaller.' })
      }
      req.body = Buffer.concat(chunks)
      return next()
    })
    req.on('error', next)
  }
}
