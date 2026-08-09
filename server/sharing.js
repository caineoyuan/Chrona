import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import { requireAuth } from './auth.js'
import { pool } from './db.js'
import {
  canInviteResource,
  grantInviteAccess,
  parseResourceId,
  parseResourceType,
  validatePermissions,
} from './sharing-auth.js'

const DEFAULT_EXPIRY_HOURS = 72
const MAX_EXPIRY_HOURS = 24 * 30
const MAX_USES = 100
const GENERIC_INVITE_RESPONSE = { ok: true }
const GENERIC_INVALID_INVITE = 'This invitation is unavailable.'

export function hashInviteToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createInviteToken() {
  return randomBytes(32).toString('base64url')
}

function parseExpiryHours(value) {
  if (value === undefined) return DEFAULT_EXPIRY_HOURS
  return Number.isInteger(value) && value >= 1 && value <= MAX_EXPIRY_HOURS
    ? value
    : null
}

function parseMaxUses(value) {
  if (value === undefined) return 1
  return Number.isInteger(value) && value >= 1 && value <= MAX_USES ? value : null
}

function normalizeExactUsername(value) {
  if (typeof value !== 'string') return null
  const username = value.trim().toLowerCase()
  return /^[a-z0-9._-]{3,32}$/.test(username) ? username : null
}

function invitationInput(body, allowMultipleUses) {
  const resourceType = parseResourceType(body?.resourceType)
  const resourceId = parseResourceId(body?.resourceId)
  const permissions = validatePermissions(resourceType, body?.permissions)
  const expiresInHours = parseExpiryHours(body?.expiresInHours)
  const maxUses = allowMultipleUses ? parseMaxUses(body?.maxUses) : 1
  if (!resourceType || !resourceId || !permissions || !expiresInHours || !maxUses) {
    return null
  }
  return { resourceType, resourceId, permissions, expiresInHours, maxUses }
}

async function withTransaction(poolFn, work) {
  const client = await poolFn.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function insertInvite(client, input, inviterId, targetUserId, tokenHash) {
  return client.query(
    `INSERT INTO share_invites (
       resource_type, resource_id, invited_by_user_id, target_user_id,
       permission_payload, token_hash, expires_at, max_uses
     )
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'), $8)
     RETURNING id, expires_at`,
    [
      input.resourceType,
      input.resourceId,
      inviterId,
      targetUserId,
      JSON.stringify(input.permissions),
      tokenHash,
      input.expiresInHours,
      input.maxUses,
    ],
  )
}

async function acceptLockedInvite(client, selector, userId) {
  const lookup = selector.tokenHash
    ? `token_hash = $1`
    : `id = $1`
  const value = selector.tokenHash || selector.id
  const result = await client.query(
    `SELECT id, resource_type, resource_id, invited_by_user_id, target_user_id,
            permission_payload, expires_at, max_uses, use_count, revoked_at
     FROM share_invites
     WHERE ${lookup}
     FOR UPDATE`,
    [value],
  )
  const invite = result.rows[0]
  if (
    !invite ||
    invite.revoked_at ||
    new Date(invite.expires_at) <= new Date() ||
    Number(invite.use_count) >= Number(invite.max_uses) ||
    (invite.target_user_id && Number(invite.target_user_id) !== Number(userId)) ||
    Number(invite.invited_by_user_id) === Number(userId)
  ) {
    return null
  }
  if (!await canInviteResource(
    client,
    invite.resource_type,
    String(invite.resource_id),
    invite.invited_by_user_id,
  )) {
    return null
  }

  const accepted = await client.query(
    `INSERT INTO share_invite_acceptances (invite_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (invite_id, user_id) DO NOTHING
     RETURNING invite_id`,
    [invite.id, userId],
  )
  if (!accepted.rows[0]) {
    return {
      resourceType: invite.resource_type,
      resourceId: String(invite.resource_id),
      alreadyAccepted: true,
    }
  }

  const granted = await grantInviteAccess(client, invite, userId)
  if (!granted) return null

  await client.query(
    `UPDATE share_invites SET use_count = use_count + 1 WHERE id = $1`,
    [invite.id],
  )
  await client.query(
    `INSERT INTO collaboration_events (
       resource_type, resource_id, actor_user_id, recipient_user_id,
       event_type, payload, deduplication_key
     )
     VALUES ($1, $2, $3, $4, 'accepted', $5, $6)
     ON CONFLICT (recipient_user_id, deduplication_key)
       WHERE deduplication_key IS NOT NULL
     DO NOTHING`,
    [
      invite.resource_type,
      invite.resource_id,
      userId,
      invite.invited_by_user_id,
      JSON.stringify({ inviteId: String(invite.id) }),
      `invite:${invite.id}:accepted:${userId}`,
    ],
  )
  return {
    resourceType: invite.resource_type,
    resourceId: String(invite.resource_id),
    alreadyAccepted: false,
  }
}

export function createSharingRouter(poolFn = pool) {
  const router = Router()

  router.post('/invitations/username', requireAuth, async (req, res) => {
    const input = invitationInput(req.body, false)
    const username = normalizeExactUsername(req.body?.username)
    if (!input || !username) {
      return res.status(400).json({ error: 'Invalid invitation details.' })
    }

    try {
      const created = await withTransaction(poolFn, async (client) => {
        if (!await canInviteResource(
          client,
          input.resourceType,
          input.resourceId,
          req.userId,
        )) {
          return false
        }
        const target = await client.query(
          `SELECT id FROM users
           WHERE lower(username) = $1 AND status = 'active'
           LIMIT 1`,
          [username],
        )
        const targetUserId = target.rows[0]?.id
        if (!targetUserId || Number(targetUserId) === Number(req.userId)) return true

        const token = createInviteToken()
        const inserted = await insertInvite(
          client,
          input,
          req.userId,
          targetUserId,
          hashInviteToken(token),
        )
        await client.query(
          `INSERT INTO collaboration_events (
             resource_type, resource_id, actor_user_id, recipient_user_id,
             event_type, payload, deduplication_key
           )
           VALUES ($1, $2, $3, $4, 'invite', $5, $6)
           ON CONFLICT (recipient_user_id, deduplication_key)
             WHERE deduplication_key IS NOT NULL
           DO NOTHING`,
          [
            input.resourceType,
            input.resourceId,
            req.userId,
            targetUserId,
            JSON.stringify({ inviteId: String(inserted.rows[0].id) }),
            `invite:${inserted.rows[0].id}`,
          ],
        )
        return true
      })
      if (!created) return res.status(404).json({ error: 'Resource not found.' })
      return res.status(202).json(GENERIC_INVITE_RESPONSE)
    } catch (error) {
      console.error('username invitation error', error)
      return res.status(500).json({ error: 'Could not create invitation.' })
    }
  })

  router.post('/invitations/link', requireAuth, async (req, res) => {
    const input = invitationInput(req.body, true)
    if (!input) return res.status(400).json({ error: 'Invalid invitation details.' })

    try {
      const token = createInviteToken()
      const result = await withTransaction(poolFn, async (client) => {
        if (!await canInviteResource(
          client,
          input.resourceType,
          input.resourceId,
          req.userId,
        )) {
          return null
        }
        return insertInvite(
          client,
          input,
          req.userId,
          null,
          hashInviteToken(token),
        )
      })
      if (!result) return res.status(404).json({ error: 'Resource not found.' })
      return res.status(201).json({
        token,
        invitePath: `/?invite=${encodeURIComponent(token)}`,
        expiresAt: result.rows[0].expires_at,
        maxUses: input.maxUses,
      })
    } catch (error) {
      console.error('link invitation error', error)
      return res.status(500).json({ error: 'Could not create invitation.' })
    }
  })

  router.get('/invitations', requireAuth, async (req, res) => {
    try {
      const result = await poolFn.query(
        `SELECT invite.id, invite.resource_type, invite.resource_id,
                invite.permission_payload, invite.expires_at,
                inviter.display_username AS invited_by_username
         FROM share_invites invite
         JOIN users inviter ON inviter.id = invite.invited_by_user_id
         WHERE invite.target_user_id = $1
           AND invite.revoked_at IS NULL
           AND invite.expires_at > now()
           AND invite.use_count < invite.max_uses
         ORDER BY invite.created_at DESC`,
        [req.userId],
      )
      return res.json({
        invitations: result.rows.map((invite) => ({
          id: String(invite.id),
          resourceType: invite.resource_type,
          resourceId: String(invite.resource_id),
          permissions: invite.permission_payload,
          invitedByUsername: invite.invited_by_username,
          expiresAt: invite.expires_at,
        })),
      })
    } catch (error) {
      console.error('list invitations error', error)
      return res.status(500).json({ error: 'Could not load invitations.' })
    }
  })

  const accept = (selectorFromRequest) => async (req, res) => {
    const selector = selectorFromRequest(req)
    if (!selector) return res.status(404).json({ error: GENERIC_INVALID_INVITE })
    try {
      const accepted = await withTransaction(
        poolFn,
        (client) => acceptLockedInvite(client, selector, req.userId),
      )
      if (!accepted) return res.status(404).json({ error: GENERIC_INVALID_INVITE })
      return res.json(accepted)
    } catch (error) {
      console.error('accept invitation error', error)
      return res.status(500).json({ error: 'Could not accept invitation.' })
    }
  }

  router.post(
    '/invitations/accept',
    requireAuth,
    accept((req) => {
      const token = typeof req.body?.token === 'string' ? req.body.token : ''
      return /^[A-Za-z0-9_-]{43}$/.test(token)
        ? { tokenHash: hashInviteToken(token) }
        : null
    }),
  )
  router.post(
    '/invitations/:id/accept',
    requireAuth,
    accept((req) => {
      const id = parseResourceId(req.params.id)
      return id ? { id } : null
    }),
  )

  router.post('/invitations/:id/decline', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Invitation not found.' })
    try {
      const declined = await withTransaction(poolFn, async (client) => {
        const result = await client.query(
          `UPDATE share_invites
           SET revoked_at = now()
           WHERE id = $1 AND target_user_id = $2
             AND revoked_at IS NULL
             AND expires_at > now()
             AND use_count < max_uses
           RETURNING id`,
          [id, req.userId],
        )
        if (!result.rows[0]) return false
        await client.query(
          `UPDATE collaboration_events
           SET read_at = COALESCE(read_at, now())
           WHERE recipient_user_id = $1
             AND event_type = 'invite'
             AND payload->>'inviteId' = $2`,
          [req.userId, id],
        )
        return true
      })
      if (!declined) {
        return res.status(404).json({ error: 'Invitation not found.' })
      }
      return res.json({ ok: true })
    } catch (error) {
      console.error('decline invitation error', error)
      return res.status(500).json({ error: 'Could not decline invitation.' })
    }
  })

  router.delete('/invitations/:id', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Invitation not found.' })
    try {
      const result = await poolFn.query(
        `UPDATE share_invites
         SET revoked_at = now()
         WHERE id = $1 AND invited_by_user_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [id, req.userId],
      )
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Invitation not found.' })
      }
      return res.json({ ok: true })
    } catch (error) {
      console.error('revoke invitation error', error)
      return res.status(500).json({ error: 'Could not revoke invitation.' })
    }
  })

  return router
}

export default createSharingRouter()
