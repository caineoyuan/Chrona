import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { requireAuth } from './auth.js'
import { pool } from './db.js'
import { medicationEventHub } from './medication-events.js'
import { profileFromRow } from './profile.js'
import { parseResourceId } from './sharing-auth.js'

const DOSE_STATUSES = new Set([
  'scheduled',
  'taken',
  'on-time',
  'late',
  'skipped',
  'missed',
])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function legacyId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.length <= 200 && value ? value : null
}

function medicationData(value) {
  if (!isObject(value)) return null
  const {
    resourceId: _resourceId,
    resourceVersion: _resourceVersion,
    resourceAccess: _resourceAccess,
    version: _version,
    role: _role,
    canViewHistory: _canViewHistory,
    ...data
  } = value
  const history = Array.isArray(data.history)
    ? data.history.map(doseEventDocument)
    : []
  if (history.some((event) => !event)) return null
  return { ...data, history }
}

function timestamp(value, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function doseEventInput(value) {
  if (!isObject(value)) return null
  const scheduledAt = timestamp(value.scheduledAt, true)
  const takenAt = timestamp(value.takenAt)
  const skippedAt = timestamp(value.skippedAt)
  const originalScheduledAt = timestamp(value.originalScheduledAt)
  if (
    scheduledAt === undefined ||
    takenAt === undefined ||
    skippedAt === undefined ||
    originalScheduledAt === undefined ||
    (takenAt && skippedAt)
  ) {
    return null
  }

  const status = DOSE_STATUSES.has(value.status)
    ? value.status
    : skippedAt
      ? 'skipped'
      : takenAt
        ? 'taken'
        : 'scheduled'
  if (
    value.injectionSite != null &&
    (typeof value.injectionSite !== 'string' || value.injectionSite.length > 200)
  ) {
    return null
  }
  return {
    legacyId: legacyId(value.id),
    scheduledAt,
    takenAt,
    skippedAt,
    originalScheduledAt,
    status,
    injectionSite: value.injectionSite || null,
  }
}

function doseEventDocument(value) {
  const event = doseEventInput(value)
  if (!event) return null
  return {
    id: event.legacyId || randomUUID(),
    scheduledAt: event.scheduledAt,
    takenAt: event.takenAt,
    skippedAt: event.skippedAt,
    originalScheduledAt: event.originalScheduledAt,
    status: event.status,
    injectionSite: event.injectionSite,
  }
}

function parseVersion(request) {
  const header = request.get('if-match')
  const raw = request.body?.version ?? (header?.replace(/^W\/|"/g, ''))
  const version = Number(raw)
  return Number.isInteger(version) && version > 0 ? version : null
}

function resourceFromRow(row) {
  const data = isObject(row.medication_data) ? { ...row.medication_data } : {}
  if (row.access_role !== 'owner' && !row.can_view_history) {
    for (const key of ['history', 'recurrenceAnchor', 'times', 'schedule', 'notifications', 'paused', 'pausePeriods']) {
      delete data[key]
    }
  }
  return {
    id: String(row.id),
    version: Number(row.version),
    access: {
      role: row.access_role,
      canViewHistory: Boolean(row.can_view_history),
      canViewSchedule: row.access_role === 'owner' || Boolean(row.can_view_history),
      canShare: Boolean(row.can_share),
      ownerUserId: String(row.owner_user_id),
      ownerUsername: row.owner_username || null,
      ownerTimezone: row.owner_timezone || null,
    },
    data: {
      ...data,
      id: row.legacy_id || data.id || String(row.id),
    },
  }
}

async function withTransaction(poolFn, work) {
  const client = await poolFn.connect()
  try {
    await client.query('BEGIN')
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function accessibleMedication(
  client,
  medicationId,
  userId,
  lock = false,
  sharingEnabled = true,
) {
  const result = await client.query(
    `SELECT m.id, m.owner_user_id, m.medication_data,
            m.version, m.legacy_id,
            owner.display_username AS owner_username,
            owner.timezone AS owner_timezone,
            CASE WHEN m.owner_user_id = $2 THEN 'owner'
                 WHEN $3::boolean THEN s.role END AS access_role,
            CASE WHEN m.owner_user_id = $2 THEN true
                 WHEN $3::boolean THEN COALESCE(s.can_view_history, false)
                 ELSE false END AS can_view_history,
            (m.owner_user_id = $2 AND $3::boolean) AS can_share
     FROM medications m
     JOIN users owner ON owner.id = m.owner_user_id
     LEFT JOIN medication_list_shares s
       ON s.owner_user_id = m.owner_user_id
      AND s.grantee_user_id = $2
      AND s.revoked_at IS NULL
     WHERE m.id = $1
       AND m.deleted_at IS NULL
       AND (m.owner_user_id = $2 OR ($3::boolean AND s.grantee_user_id IS NOT NULL))
     ${lock ? 'FOR UPDATE OF m' : ''}`,
    [medicationId, userId, sharingEnabled],
  )
  return result.rows[0] || null
}

function canEdit(row) {
  return row && ['owner', 'editor'].includes(row.access_role)
}

async function notifyMedicationChange(
  poolFn,
  ownerUserId,
  actorUserId,
  event,
) {
  if (!medicationEventHub.hasSubscribers()) return
  try {
    const shared = await poolFn.query(
      `SELECT grantee_user_id
       FROM medication_list_shares
       WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [ownerUserId],
    )
    medicationEventHub.publish(
      [ownerUserId, ...shared.rows.map((row) => row.grantee_user_id)],
      event,
      actorUserId,
    )
  } catch (error) {
    console.error('publish medication change error', error)
  }
}

function versionConflict(response, currentVersion) {
  return response.status(409).json({
    error: 'Medication version conflict.',
    currentVersion: Number(currentVersion),
  })
}

async function ownerMedicationRows(client, ownerId) {
  return client.query(
    `SELECT id, medication_data, legacy_id, legacy_position, version,
            created_at, updated_at
     FROM medications
     WHERE owner_user_id = $1 AND deleted_at IS NULL
     ORDER BY legacy_position NULLS LAST, created_at, id`,
    [ownerId],
  )
}

async function buildLegacyArray(client, ownerId) {
  const medications = (await ownerMedicationRows(client, ownerId)).rows
  return medications.map((row) => {
    const data = isObject(row.medication_data) ? { ...row.medication_data } : {}
    return {
      ...data,
      id: row.legacy_id || data.id || String(row.id),
      history: Array.isArray(data.history) ? data.history : [],
    }
  })
}

async function replaceOwnerFromLegacy(client, ownerId, medications) {
  const current = await client.query(
    `SELECT id, legacy_id, legacy_position
     FROM medications
     WHERE owner_user_id = $1
     FOR UPDATE`,
    [ownerId],
  )
  const byLegacyId = new Map(
    current.rows.filter((row) => row.legacy_id).map((row) => [row.legacy_id, row]),
  )
  const byPosition = new Map(current.rows.map((row) => [Number(row.legacy_position), row]))
  await client.query(
    'UPDATE medications SET legacy_position = NULL WHERE owner_user_id = $1',
    [ownerId],
  )

  const retained = []
  for (const [index, rawMedication] of medications.entries()) {
    const data = medicationData(rawMedication)
    if (!data) throw Object.assign(new Error('Invalid medication.'), { status: 400 })
    const clientId = legacyId(rawMedication.id)
    const existing = (clientId && byLegacyId.get(clientId)) || byPosition.get(index + 1)
    let medicationId
    if (existing) {
      medicationId = existing.id
      await client.query(
        `UPDATE medications
         SET medication_data = $2, legacy_id = COALESCE($3, legacy_id),
             legacy_position = $4, version = version + 1,
             updated_at = now(), deleted_at = NULL
         WHERE id = $1`,
        [medicationId, JSON.stringify(data), clientId, index + 1],
      )
    } else {
      const inserted = await client.query(
        `INSERT INTO medications (
           owner_user_id, medication_data, legacy_id, legacy_position
         )
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [ownerId, JSON.stringify(data), clientId, index + 1],
      )
      medicationId = inserted.rows[0].id
    }
    retained.push(medicationId)
  }

  await client.query(
    `UPDATE medications
     SET deleted_at = now(), updated_at = now(), version = version + 1
     WHERE owner_user_id = $1
       AND deleted_at IS NULL
       AND NOT (id = ANY($2::bigint[]))`,
    [ownerId, retained],
  )
}

export function createMedicationsRouter(poolFn = pool, options = {}) {
  const router = Router()
  const sharingEnabled = options.sharing === true
  const findAccessibleMedication = (client, medicationId, userId, lock = false) =>
    accessibleMedication(client, medicationId, userId, lock, sharingEnabled)

  router.get(
    '/events',
    sharingEnabled ? requireAuth : (_request, response) =>
      response.status(404).json({ error: 'Not found.' }),
    (request, response) => {
      response.status(200)
      response.set({
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      })
      response.flushHeaders?.()
      response.write('retry: 5000\n\n')
      const unsubscribe = medicationEventHub.subscribe(
        request.userId,
        (event) => response.write(`data: ${JSON.stringify(event)}\n\n`),
      )
      const heartbeat = setInterval(
        () => response.write(': heartbeat\n\n'),
        25_000,
      )
      request.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
    },
  )

  // Compatibility endpoint backed by the canonical medication documents.
  router.get('/', requireAuth, async (request, response) => {
    try {
      return response.json({
        medications: await buildLegacyArray(poolFn, request.userId),
      })
    } catch (error) {
      console.error('get medications error', error)
      return response.status(500).json({ error: 'Could not load your medications.' })
    }
  })

  router.put('/', requireAuth, async (request, response) => {
    const medications = request.body?.medications
    if (!Array.isArray(medications) || medications.some((item) => !isObject(item))) {
      return response.status(400).json({ error: 'Expected an array of medications.' })
    }
    try {
      await withTransaction(
        poolFn,
        (client) => replaceOwnerFromLegacy(client, request.userId, medications),
      )
      await notifyMedicationChange(
        poolFn,
        request.userId,
        request.userId,
        { change: 'list' },
      )
      return response.json({ ok: true })
    } catch (error) {
      if (error.status === 400) return response.status(400).json({ error: error.message })
      console.error('put medications error', error)
      return response.status(500).json({ error: 'Could not save your medications.' })
    }
  })

  router.get(
    '/lists',
    sharingEnabled ? requireAuth : (_request, response) =>
      response.status(404).json({ error: 'Not found.' }),
    async (request, response) => {
      try {
        const result = await poolFn.query(
          `SELECT u.id, u.username, u.display_username, u.timezone,
                  u.avatar_kind, u.avatar_value, u.avatar_color, u.avatar_file,
                  access.role, access.can_view_history
           FROM (
             SELECT $1::integer AS owner_user_id, 'owner'::text AS role,
                    true AS can_view_history
             UNION ALL
             SELECT share.owner_user_id, share.role, share.can_view_history
             FROM medication_list_shares share
             WHERE share.grantee_user_id = $1 AND share.revoked_at IS NULL
           ) access
           JOIN users u ON u.id = access.owner_user_id
           WHERE u.status = 'active'
           ORDER BY (u.id = $1) DESC, lower(u.display_username), u.id`,
          [request.userId],
        )
        return response.json({
          lists: result.rows.map((row) => ({
            ownerUserId: String(row.id),
            username: row.display_username,
            timezone: row.timezone,
            role: row.role,
            canViewHistory: Boolean(row.can_view_history),
            avatar: profileFromRow(row).avatar,
          })),
        })
      } catch (error) {
        console.error('list shared medication lists error', error)
        return response.status(500).json({ error: 'Could not load medication profiles.' })
      }
    },
  )

  router.get(
    '/list/shares',
    sharingEnabled ? requireAuth : (_request, response) =>
      response.status(404).json({ error: 'Not found.' }),
    async (request, response) => {
      try {
        await poolFn.query(
          `INSERT INTO medication_lists (owner_user_id)
           VALUES ($1)
           ON CONFLICT (owner_user_id) DO NOTHING`,
          [request.userId],
        )
        const [list, members, invitations] = await Promise.all([
          poolFn.query(
            `SELECT version FROM medication_lists WHERE owner_user_id = $1`,
            [request.userId],
          ),
          poolFn.query(
            `SELECT u.id, u.username, u.display_username, u.timezone,
                    u.avatar_kind, u.avatar_value, u.avatar_color, u.avatar_file,
                    share.role, share.can_view_history
             FROM medication_list_shares share
             JOIN users u ON u.id = share.grantee_user_id
             WHERE share.owner_user_id = $1 AND share.revoked_at IS NULL
             ORDER BY lower(u.display_username), u.id`,
            [request.userId],
          ),
          poolFn.query(
            `SELECT invite.id, invite.target_user_id, target.display_username,
                    invite.permission_payload, invite.expires_at,
                    invite.max_uses, invite.use_count
             FROM share_invites invite
             LEFT JOIN users target ON target.id = invite.target_user_id
             WHERE invite.resource_type = 'medication_list'
               AND invite.resource_id = $1
               AND invite.invited_by_user_id = $1
               AND invite.revoked_at IS NULL
               AND invite.expires_at > now()
               AND invite.use_count < invite.max_uses
             ORDER BY invite.created_at DESC`,
            [request.userId],
          ),
        ])
        return response.json({
          resourceId: String(request.userId),
          version: Number(list.rows[0].version),
          members: members.rows.map((row) => ({
            userId: String(row.id),
            username: row.display_username,
            role: row.role,
            canViewHistory: Boolean(row.can_view_history),
            avatar: profileFromRow(row).avatar,
          })),
          invitations: invitations.rows.map((row) => ({
            id: String(row.id),
            username: row.display_username || null,
            permissions: {
              role: row.permission_payload.role,
              canViewHistory: Boolean(row.permission_payload.can_view_history),
            },
            expiresAt: row.expires_at,
            maxUses: Number(row.max_uses),
            useCount: Number(row.use_count),
          })),
        })
      } catch (error) {
        console.error('list medication list shares error', error)
        return response.status(500).json({ error: 'Could not load medication sharing.' })
      }
    },
  )

  router.delete(
    '/list/shares/:userId',
    sharingEnabled ? requireAuth : (_request, response) =>
      response.status(404).json({ error: 'Not found.' }),
    async (request, response) => {
      const userId = parseResourceId(request.params.userId)
      const version = parseVersion(request)
      if (!userId) return response.status(404).json({ error: 'Medication member not found.' })
      if (!version) return response.status(400).json({ error: 'Version is required.' })
      try {
        const result = await withTransaction(poolFn, async (client) => {
          const list = await client.query(
            `SELECT version
             FROM medication_lists
             WHERE owner_user_id = $1
             FOR UPDATE`,
            [request.userId],
          )
          if (!list.rows[0]) return { missing: true }
          if (Number(list.rows[0].version) !== version) {
            return { conflict: list.rows[0].version }
          }
          const revoked = await client.query(
            `UPDATE medication_list_shares
             SET revoked_at = now()
             WHERE owner_user_id = $1 AND grantee_user_id = $2
               AND revoked_at IS NULL
             RETURNING grantee_user_id`,
            [request.userId, userId],
          )
          if (!revoked.rows[0]) return { missing: true }
          const updated = await client.query(
            `UPDATE medication_lists
             SET version = version + 1, updated_at = now()
             WHERE owner_user_id = $1
             RETURNING version`,
            [request.userId],
          )
          return { version: Number(updated.rows[0].version) }
        })
        if (result.missing) {
          return response.status(404).json({ error: 'Medication member not found.' })
        }
        if (result.conflict) return versionConflict(response, result.conflict)
        return response.json({ ok: true, version: result.version })
      } catch (error) {
        console.error('revoke medication list member error', error)
        return response.status(500).json({ error: 'Could not revoke medication access.' })
      }
    },
  )

  router.get('/resources', requireAuth, async (request, response) => {
    try {
      const result = await poolFn.query(
        `SELECT m.id, m.owner_user_id,
                m.medication_data,
                m.version, m.legacy_id,
                owner.display_username AS owner_username,
                owner.timezone AS owner_timezone,
                CASE WHEN m.owner_user_id = $1 THEN 'owner'
                     WHEN $2::boolean THEN s.role END AS access_role,
                CASE WHEN m.owner_user_id = $1 THEN true
                     WHEN $2::boolean THEN COALESCE(s.can_view_history, false)
                     ELSE false END AS can_view_history,
                (m.owner_user_id = $1 AND $2::boolean) AS can_share
         FROM medications m
         JOIN users owner ON owner.id = m.owner_user_id
         LEFT JOIN medication_list_shares s
           ON s.owner_user_id = m.owner_user_id
          AND s.grantee_user_id = $1
          AND s.revoked_at IS NULL
         WHERE m.deleted_at IS NULL
           AND (m.owner_user_id = $1 OR ($2::boolean AND s.grantee_user_id IS NOT NULL))
         ORDER BY m.updated_at DESC, m.id DESC`,
        [request.userId, sharingEnabled],
      )
      return response.json({ medications: result.rows.map(resourceFromRow) })
    } catch (error) {
      console.error('list medication resources error', error)
      return response.status(500).json({ error: 'Could not load medications.' })
    }
  })

  router.post('/resources', requireAuth, async (request, response) => {
    const data = medicationData(request.body?.medication ?? request.body?.data)
    if (!data) return response.status(400).json({ error: 'Invalid medication.' })
    const clientId = legacyId(data.id)
    try {
      const row = await withTransaction(poolFn, async (client) => {
        const inserted = await client.query(
          `INSERT INTO medications (owner_user_id, medication_data, legacy_id)
           VALUES ($1, $2, $3)
           RETURNING id, owner_user_id, medication_data, version, legacy_id,
                     'owner'::text AS access_role, true AS can_view_history,
                     true AS can_share`,
          [request.userId, JSON.stringify(data), clientId],
        )
        if (!clientId) {
          const assigned = await client.query(
            `UPDATE medications
             SET legacy_id = id::text,
                 medication_data = medication_data || jsonb_build_object('id', id::text)
             WHERE id = $1
             RETURNING id, owner_user_id, medication_data, version, legacy_id,
                       'owner'::text AS access_role, true AS can_view_history,
                       true AS can_share`,
            [inserted.rows[0].id],
          )
          inserted.rows[0] = assigned.rows[0]
        }
        return inserted.rows[0]
      })
      await notifyMedicationChange(poolFn, row.owner_user_id, request.userId, {
        change: 'created',
        resourceId: String(row.id),
        version: Number(row.version),
      })
      return response.status(201).json({ medication: resourceFromRow(row) })
    } catch (error) {
      console.error('create medication resource error', error)
      return response.status(500).json({ error: 'Could not create medication.' })
    }
  })

  router.get('/resources/:id', requireAuth, async (request, response) => {
    const id = parseResourceId(request.params.id)
    if (!id) return response.status(404).json({ error: 'Medication not found.' })
    try {
      const row = await findAccessibleMedication(poolFn, id, request.userId)
      if (!row) return response.status(404).json({ error: 'Medication not found.' })
      return response.json({ medication: resourceFromRow(row) })
    } catch (error) {
      console.error('get medication resource error', error)
      return response.status(500).json({ error: 'Could not load medication.' })
    }
  })

  const updateResource = async (request, response) => {
    const id = parseResourceId(request.params.id)
    const version = parseVersion(request)
    const data = medicationData(request.body?.medication ?? request.body?.data)
    if (!id) return response.status(404).json({ error: 'Medication not found.' })
    if (!version || !data) return response.status(400).json({ error: 'Medication and version are required.' })
    try {
      const result = await withTransaction(poolFn, async (client) => {
        const current = await findAccessibleMedication(client, id, request.userId, true)
        if (!current) return { missing: true }
        if (!canEdit(current)) return { forbidden: true }
        if (Number(current.version) !== version) return { conflict: current.version }
        const nextData = current.access_role === 'editor' && !current.can_view_history
          ? ['history', 'recurrenceAnchor', 'times', 'schedule', 'notifications', 'paused', 'pausePeriods']
            .reduce((merged, key) => {
              if (current.medication_data?.[key] !== undefined) {
                merged[key] = current.medication_data[key]
              } else {
                delete merged[key]
              }
              return merged
            }, { ...data })
          : data
        const updated = await client.query(
          `UPDATE medications
           SET medication_data = $2, legacy_id = COALESCE($3, legacy_id),
               version = version + 1, updated_at = now()
           WHERE id = $1
           RETURNING id, owner_user_id, medication_data, version, legacy_id`,
          [id, JSON.stringify(nextData), legacyId(data.id)],
        )
        const row = {
          ...updated.rows[0],
          access_role: current.access_role,
          can_view_history: current.can_view_history,
          can_share: current.can_share,
          owner_username: current.owner_username,
          owner_timezone: current.owner_timezone,
        }
        return { row }
      })
      if (result.missing) return response.status(404).json({ error: 'Medication not found.' })
      if (result.forbidden) return response.status(403).json({ error: 'Medication is read-only.' })
      if (result.conflict) return versionConflict(response, result.conflict)
      await notifyMedicationChange(
        poolFn,
        result.row.owner_user_id,
        request.userId,
        {
          change: 'updated',
          resourceId: String(result.row.id),
          version: Number(result.row.version),
        },
      )
      return response.json({ medication: resourceFromRow(result.row) })
    } catch (error) {
      console.error('update medication resource error', error)
      return response.status(500).json({ error: 'Could not update medication.' })
    }
  }
  router.put('/resources/:id', requireAuth, updateResource)
  router.patch('/resources/:id', requireAuth, updateResource)

  router.delete('/resources/:id', requireAuth, async (request, response) => {
    const id = parseResourceId(request.params.id)
    const version = parseVersion(request)
    if (!id) return response.status(404).json({ error: 'Medication not found.' })
    if (!version) return response.status(400).json({ error: 'Version is required.' })
    try {
      const result = await withTransaction(poolFn, async (client) => {
        const current = await findAccessibleMedication(client, id, request.userId, true)
        if (!current) return { missing: true }
        if (current.access_role !== 'owner') return { forbidden: true }
        if (Number(current.version) !== version) return { conflict: current.version }
        await client.query(
          `UPDATE medications
           SET deleted_at = now(), updated_at = now(), version = version + 1
           WHERE id = $1`,
          [id],
        )
        await client.query(
          `UPDATE medication_dose_events
           SET deleted_at = now(), updated_at = now(), version = version + 1
           WHERE medication_id = $1 AND deleted_at IS NULL`,
          [id],
        )
        return {
          ok: true,
          ownerUserId: current.owner_user_id,
        }
      })

      if (result.missing) return response.status(404).json({ error: 'Medication not found.' })
      if (result.forbidden) return response.status(403).json({ error: 'Only the owner can delete this medication.' })
      if (result.conflict) return versionConflict(response, result.conflict)
      await notifyMedicationChange(
        poolFn,
        result.ownerUserId,
        request.userId,
        { change: 'deleted', resourceId: id },
      )
      return response.json({ ok: true })
    } catch (error) {
      console.error('delete medication resource error', error)
      return response.status(500).json({ error: 'Could not delete medication.' })
    }
  })

  router.get('/resources/:id/dose-events', requireAuth, async (request, response) => {
    const id = parseResourceId(request.params.id)
    if (!id) return response.status(404).json({ error: 'Medication not found.' })
    try {
      const medication = await findAccessibleMedication(poolFn, id, request.userId)
      if (!medication) return response.status(404).json({ error: 'Medication not found.' })
      if (!medication.can_view_history) {
        return response.status(403).json({ error: 'Medication history is not shared.' })
      }
      return response.json({
        medicationId: id,
        version: Number(medication.version),
        doseEvents: Array.isArray(medication.medication_data?.history)
          ? medication.medication_data.history
          : [],
      })
    } catch (error) {
      console.error('list medication dose events error', error)
      return response.status(500).json({ error: 'Could not load medication history.' })
    }
  })

  async function mutateDoseEvent(request, response, operation) {
    const medicationId = parseResourceId(request.params.id)
    const eventId = request.params.eventId
    const validEventId = !eventId ||
      (typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 200)
    const version = parseVersion(request)
    const event = operation === 'delete'
      ? null
      : doseEventDocument(request.body?.doseEvent ?? request.body?.event)
    if (!medicationId || !validEventId) {
      return response.status(404).json({ error: 'Medication or dose event not found.' })
    }
    if (!version || (operation !== 'delete' && !event)) {
      return response.status(400).json({ error: 'Dose event and medication version are required.' })
    }
    try {
      const result = await withTransaction(poolFn, async (client) => {
        const medication = await findAccessibleMedication(
          client,
          medicationId,
          request.userId,
          true,
        )
        if (!medication) return { missing: true }
        if (!canEdit(medication)) return { forbidden: true }
        if (!medication.can_view_history) return { historyForbidden: true }
        if (Number(medication.version) !== version) {
          return { conflict: medication.version }
        }

        const history = Array.isArray(medication.medication_data?.history)
          ? medication.medication_data.history
          : []
        let changed = event
        let nextHistory
        if (operation === 'create') {
          nextHistory = [...history.filter((item) => item.id !== event.id), event]
        } else if (operation === 'update') {
          const index = history.findIndex((item) => item.id === eventId)
          if (index < 0) return { eventMissing: true }
          changed = { ...event, id: history[index].id }
          nextHistory = history.map((item, itemIndex) =>
            itemIndex === index ? changed : item)
        } else {
          if (!history.some((item) => item.id === eventId)) {
            return { eventMissing: true }
          }
          nextHistory = history.filter((item) => item.id !== eventId)
        }
        const nextData = { ...medication.medication_data, history: nextHistory }
        const updated = await client.query(
          `UPDATE medications
           SET medication_data = $2, version = version + 1, updated_at = now()
           WHERE id = $1
           RETURNING version`,
          [medicationId, JSON.stringify(nextData)],
        )
        return {
          version: Number(updated.rows[0].version),
          event: operation === 'delete' ? null : changed,
          ownerUserId: medication.owner_user_id,
        }
      })
      if (result.missing || result.eventMissing) {
        return response.status(404).json({ error: 'Medication or dose event not found.' })
      }
      if (result.forbidden) return response.status(403).json({ error: 'Medication is read-only.' })
      if (result.historyForbidden) {
        return response.status(403).json({ error: 'Medication history is not shared.' })
      }
      if (result.conflict) return versionConflict(response, result.conflict)
      await notifyMedicationChange(
        poolFn,
        result.ownerUserId,
        request.userId,
        {
          change: 'updated',
          resourceId: medicationId,
          version: result.version,
        },
      )
      return response.status(operation === 'create' ? 201 : 200).json(
        operation === 'delete'
          ? { ok: true, version: result.version }
          : { doseEvent: result.event, version: result.version },
      )
    } catch (error) {
      console.error(`${operation} medication dose event error`, error)
      return response.status(500).json({ error: 'Could not change medication history.' })
    }
  }

  router.post(
    '/resources/:id/dose-events',
    requireAuth,
    (request, response) => mutateDoseEvent(request, response, 'create'),
  )
  router.put(
    '/resources/:id/dose-events/:eventId',
    requireAuth,
    (request, response) => mutateDoseEvent(request, response, 'update'),
  )
  router.patch(
    '/resources/:id/dose-events/:eventId',
    requireAuth,
    (request, response) => mutateDoseEvent(request, response, 'update'),
  )
  router.delete(
    '/resources/:id/dose-events/:eventId',
    requireAuth,
    (request, response) => mutateDoseEvent(request, response, 'delete'),
  )

  return router
}

export default createMedicationsRouter()
