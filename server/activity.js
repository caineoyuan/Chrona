import { Router } from 'express'
import { requireAuth } from './auth.js'
import { minimalEventPayload } from './collaboration-events.js'
import { pool } from './db.js'
import { parseResourceId } from './sharing-auth.js'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT
  const limit = Number(value)
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null
}

function eventFromRow(row) {
  return {
    id: String(row.id),
    resourceType: row.resource_type,
    resourceId: String(row.resource_id),
    eventType: row.event_type,
    actor: row.actor_user_id
      ? {
          userId: String(row.actor_user_id),
          username: row.actor_username,
          displayUsername: row.actor_display_username || row.actor_username,
        }
      : null,
    payload: minimalEventPayload(row.event_type, row.payload),
    createdAt: row.created_at,
    readAt: row.read_at,
  }
}

export function createActivityRouter(poolFn = pool) {
  const router = Router()

  router.get('/', requireAuth, async (req, res) => {
    const limit = parseLimit(req.query.limit)
    const cursor = req.query.cursor === undefined
      ? null
      : parseResourceId(req.query.cursor)
    if (!limit || (req.query.cursor !== undefined && !cursor)) {
      return res.status(400).json({ error: 'Invalid activity pagination.' })
    }
    try {
      const result = await poolFn.query(
        `SELECT event.id, event.resource_type, event.resource_id,
                event.actor_user_id, event.event_type, event.payload,
                event.created_at, event.read_at, actor.username AS actor_username,
                actor.display_username AS actor_display_username
         FROM collaboration_events event
         LEFT JOIN users actor ON actor.id = event.actor_user_id
         WHERE event.recipient_user_id = $1
           AND ($2::bigint IS NULL OR event.id < $2)
         ORDER BY event.id DESC
         LIMIT $3`,
        [req.userId, cursor, limit + 1],
      )
      const hasMore = result.rows.length > limit
      const rows = result.rows.slice(0, limit)
      return res.json({
        activities: rows.map(eventFromRow),
        nextCursor: hasMore ? String(rows.at(-1).id) : null,
      })
    } catch (error) {
      console.error('list collaboration activity error', error)
      return res.status(500).json({ error: 'Could not load activity.' })
    }
  })

  router.post('/read-all', requireAuth, async (req, res) => {
    try {
      const result = await poolFn.query(
        `UPDATE collaboration_events
         SET read_at = now()
         WHERE recipient_user_id = $1 AND read_at IS NULL`,
        [req.userId],
      )
      return res.json({ ok: true, markedRead: result.rowCount || 0 })
    } catch (error) {
      console.error('mark all collaboration activity read error', error)
      return res.status(500).json({ error: 'Could not mark activity read.' })
    }
  })

  router.post('/:id/read', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Activity not found.' })
    try {
      const result = await poolFn.query(
        `UPDATE collaboration_events
         SET read_at = COALESCE(read_at, now())
         WHERE id = $1 AND recipient_user_id = $2
         RETURNING id, read_at`,
        [id, req.userId],
      )
      if (!result.rows[0]) return res.status(404).json({ error: 'Activity not found.' })
      return res.json({
        ok: true,
        id: String(result.rows[0].id),
        readAt: result.rows[0].read_at,
      })
    } catch (error) {
      console.error('mark collaboration activity read error', error)
      return res.status(500).json({ error: 'Could not mark activity read.' })
    }
  })

  return router
}

export default createActivityRouter()
