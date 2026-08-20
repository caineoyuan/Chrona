import { Router } from 'express'
import { requireAuth } from './auth.js'
import { pool } from './db.js'
import {
  buddyPeriodKey,
  buddyPeriodKeyForDate,
  buddyCompletionTarget,
  computeGroupStreak,
  localCalendarDate,
  localStreakDate,
  membershipDates,
  normalizeIanaTimezone,
  occurrenceCompletion,
  privateCompletionEntries,
  sanitizeBuddyDefinition,
} from './buddy-core.js'
import {
  insertCollaborationEvent,
  notifyActiveBuddyMembers,
} from './collaboration-events.js'
import { parseResourceId } from './sharing-auth.js'
import { profileFromRow } from './profile.js'
import { buddyEventHub } from './buddy-events.js'

async function transaction(poolFn, work) {
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

function memberFromRow(row) {
  const dates = membershipDates(row)
  return {
    userId: String(row.user_id),
    username: row.username,
    displayUsername: row.display_username || row.username,
    avatar: profileFromRow(row).avatar,
    role: row.role,
    timezone: row.timezone,
    joinedAt: row.joined_at,
    activeAt: row.active_at,
    removedAt: row.removed_at,
    ...dates,
  }
}

function completionFromRow(row) {
  return {
    userId: String(row.user_id),
    periodKey: row.period_key,
    completionDate: row.completion_date
      ? String(row.completion_date).slice(0, 10)
      : String(row.local_completed_at || '').slice(0, 10),
    localCompletedAt: row.local_completed_at,
    completedAt: row.completed_at,
    source: row.source,
  }
}

async function loadBuddy(client, id, userId) {
  const streakResult = await client.query(
    `SELECT streak.id, streak.definition, streak.version,
            streak.created_by_user_id, streak.created_at, streak.updated_at,
            streak.legacy_set_id, requesting.role AS requesting_role
     FROM buddy_streaks streak
     JOIN buddy_streak_members requesting
       ON requesting.buddy_streak_id = streak.id
      AND requesting.user_id = $2
      AND requesting.removed_at IS NULL
     WHERE streak.id = $1 AND streak.deleted_at IS NULL`,
    [id, userId],
  )
  const streak = streakResult.rows[0]
  if (!streak) return null
  const [membersResult, completionsResult] = await Promise.all([
    client.query(
      `SELECT member.user_id, member.role, member.timezone, member.joined_at,
              member.active_at, member.removed_at, users.username,
              users.display_username, users.avatar_kind, users.avatar_value,
              users.avatar_color, users.avatar_file
       FROM buddy_streak_members member
       JOIN users ON users.id = member.user_id
       WHERE member.buddy_streak_id = $1
       ORDER BY member.joined_at, member.user_id`,
      [id],
    ),
    client.query(
      `SELECT user_id, period_key, completion_date::text AS completion_date,
              local_completed_at,
              completed_at, source
       FROM buddy_streak_completions
       WHERE buddy_streak_id = $1
       ORDER BY period_key, user_id`,
      [id],
    ),
  ])
  const members = membersResult.rows.map(memberFromRow)
  const completions = completionsResult.rows.map(completionFromRow)
  const periodKeys = [...new Set(completions.map(({ periodKey }) => periodKey))]
  const requestingMember = members.find(
    ({ userId: memberId }) => memberId === String(userId),
  )
  const currentPeriodKey = buddyPeriodKey(
    streak.definition,
    new Date(),
    requestingMember?.timezone || 'UTC',
  )
  const currentOccurrence = occurrenceCompletion(
    currentPeriodKey,
    members,
    completions,
    streak.definition,
  )
  return {
    id: String(streak.id),
    definition: streak.definition,
    version: streak.version,
    createdByUserId: String(streak.created_by_user_id),
    createdAt: streak.created_at,
    updatedAt: streak.updated_at,
    legacySetId: streak.legacy_set_id,
    requestingRole: streak.requesting_role,
    canAdminister: streak.requesting_role === 'participant',
    members,
    completions,
    currentPeriodKey,
    currentOccurrence,
    occurrences: periodKeys.map((key) =>
      occurrenceCompletion(key, members, completions, streak.definition)),
    groupStreak: computeGroupStreak(
      streak.definition,
      members,
      completions,
      new Date(),
      requestingMember?.timezone || 'UTC',
    ),
  }
}

async function activeMembership(client, id, userId, lock = false) {
  const result = await client.query(
    `SELECT member.role, member.timezone, streak.definition, streak.version
     FROM buddy_streak_members member
     JOIN buddy_streaks streak ON streak.id = member.buddy_streak_id
     WHERE member.buddy_streak_id = $1
       AND member.user_id = $2
       AND member.removed_at IS NULL
       AND streak.deleted_at IS NULL
     ${lock ? 'FOR UPDATE OF streak' : ''}`,
    [id, userId],
  )
  return result.rows[0] || null
}

async function publishBuddyChange(poolFn, buddyStreakId, actorUserId, event) {
  try {
    const members = await poolFn.query(
      `SELECT user_id FROM buddy_streak_members
       WHERE buddy_streak_id = $1 AND removed_at IS NULL`,
      [buddyStreakId],
    )
    buddyEventHub.publish(
      members.rows.map(({ user_id }) => user_id),
      event,
      actorUserId,
    )
  } catch (error) {
    console.error('publish buddy streak change error', error)
  }
}

function parseVersion(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

function sendConflict(res, currentVersion) {
  return res.status(409).json({
    error: 'Buddy streak has changed.',
    currentVersion: Number(currentVersion),
  })
}

function localTimestamp(date, timezone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [
      type,
      value,
    ]),
  )
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`
}

export function createBuddyStreaksRouter(poolFn = pool) {
  const router = Router()

  router.get('/events', requireAuth, (request, response) => {
    response.status(200)
    response.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders?.()
    response.write('retry: 5000\n\n')
    const unsubscribe = buddyEventHub.subscribe(
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
  })

  router.post('/', requireAuth, async (req, res) => {
    const definition = sanitizeBuddyDefinition(req.body?.definition)
    if (!definition) return res.status(400).json({ error: 'Invalid buddy streak definition.' })
    try {
      const id = await transaction(poolFn, async (client) => {
        const user = await client.query(
          `SELECT timezone FROM users WHERE id = $1 AND status = 'active'`,
          [req.userId],
        )
        if (!user.rows[0]) return null
        const inserted = await client.query(
          `INSERT INTO buddy_streaks (definition, created_by_user_id)
           VALUES ($1, $2) RETURNING id`,
          [JSON.stringify(definition), req.userId],
        )
        await client.query(
          `INSERT INTO buddy_streak_members (
             buddy_streak_id, user_id, role, timezone
           ) VALUES ($1, $2, 'participant', $3)`,
          [inserted.rows[0].id, req.userId, user.rows[0].timezone],
        )
        return inserted.rows[0].id
      })
      if (!id) return res.status(401).json({ error: 'Not authenticated' })
      return res.status(201).json(await loadBuddy(poolFn, id, req.userId))
    } catch (error) {
      console.error('create buddy streak error', error)
      return res.status(500).json({ error: 'Could not create buddy streak.' })
    }
  })

  router.post('/promote', requireAuth, async (req, res) => {
    const legacySetId = typeof req.body?.setId === 'string' ? req.body.setId : ''
    if (!legacySetId || legacySetId.length > 200) {
      return res.status(400).json({ error: 'Invalid private set id.' })
    }
    try {
      const promoted = await transaction(poolFn, async (client) => {
        const existing = await client.query(
          `SELECT id FROM buddy_streaks
           WHERE created_by_user_id = $1 AND legacy_set_id = $2
             AND deleted_at IS NULL`,
          [req.userId, legacySetId],
        )
        if (existing.rows[0]) return existing.rows[0].id
        const [setsResult, userResult] = await Promise.all([
          client.query(
            `SELECT sets FROM user_sets WHERE user_id = $1 FOR UPDATE`,
            [req.userId],
          ),
          client.query(
            `SELECT timezone FROM users WHERE id = $1 AND status = 'active'`,
            [req.userId],
          ),
        ])
        const set = (setsResult.rows[0]?.sets || [])
          .find((candidate) => String(candidate?.id) === legacySetId)
        const definition = sanitizeBuddyDefinition(set)
        if (!set || !definition || !userResult.rows[0]) return null
        const createdAt = new Date(set.createdAt)
        const effectiveAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
        const inserted = await client.query(
          `INSERT INTO buddy_streaks (
             definition, created_by_user_id, legacy_set_id
           ) VALUES ($1, $2, $3) RETURNING id`,
          [JSON.stringify(definition), req.userId, legacySetId],
        )
        const id = inserted.rows[0].id
        await client.query(
          `INSERT INTO buddy_streak_members (
             buddy_streak_id, user_id, role, timezone, joined_at, active_at
           ) VALUES ($1, $2, 'participant', $3, $4, $4)`,
          [
            id,
            req.userId,
            userResult.rows[0].timezone,
            effectiveAt,
          ],
        )
        for (const { periodKey, completionDate } of privateCompletionEntries(set)) {
          await client.query(
            `INSERT INTO buddy_streak_completions (
               buddy_streak_id, user_id, period_key, completion_date,
               local_completed_at, source
             ) VALUES ($1, $2, $3, $4, $5, 'import')
             ON CONFLICT DO NOTHING`,
            [
              id,
              req.userId,
              periodKey,
              completionDate,
              `${completionDate} 12:00:00`,
            ],
          )
        }
        return id
      })
      if (!promoted) return res.status(404).json({ error: 'Private set not found.' })
      return res.status(201).json(await loadBuddy(poolFn, promoted, req.userId))
    } catch (error) {
      if (error?.code === '23505') {
        const existing = await poolFn.query(
          `SELECT id FROM buddy_streaks
           WHERE created_by_user_id = $1 AND legacy_set_id = $2
             AND deleted_at IS NULL`,
          [req.userId, legacySetId],
        )
        if (existing.rows[0]) {
          return res.status(200).json(
            await loadBuddy(poolFn, existing.rows[0].id, req.userId),
          )
        }
      }
      console.error('promote buddy streak error', error)
      return res.status(500).json({ error: 'Could not promote private set.' })
    }
  })

  router.get('/', requireAuth, async (req, res) => {
    try {
      const result = await poolFn.query(
        `SELECT streak.id
         FROM buddy_streaks streak
         JOIN buddy_streak_members member ON member.buddy_streak_id = streak.id
         WHERE member.user_id = $1 AND member.removed_at IS NULL
           AND streak.deleted_at IS NULL
         ORDER BY streak.updated_at DESC`,
        [req.userId],
      )
      const streaks = []
      for (const row of result.rows) {
        streaks.push(await loadBuddy(poolFn, row.id, req.userId))
      }
      return res.json({ buddyStreaks: streaks })
    } catch (error) {
      console.error('list buddy streaks error', error)
      return res.status(500).json({ error: 'Could not load buddy streaks.' })
    }
  })

  router.get('/:id', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    try {
      const buddy = await loadBuddy(poolFn, id, req.userId)
      if (!buddy) return res.status(404).json({ error: 'Buddy streak not found.' })
      return res.json(buddy)
    } catch (error) {
      console.error('get buddy streak error', error)
      return res.status(500).json({ error: 'Could not load buddy streak.' })
    }
  })

  router.patch('/:id', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    const version = parseVersion(req.body?.version)
    const definition = sanitizeBuddyDefinition(req.body?.definition)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    if (!version || !definition) {
      return res.status(400).json({ error: 'Definition and version are required.' })
    }
    try {
      const result = await transaction(poolFn, async (client) => {
        const membership = await activeMembership(client, id, req.userId, true)
        if (!membership) return { status: 'missing' }
        if (membership.role !== 'participant') return { status: 'forbidden' }
        const updated = await client.query(
          `UPDATE buddy_streaks
           SET definition = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND version = $3 AND deleted_at IS NULL
           RETURNING version`,
          [JSON.stringify(definition), id, version],
        )
        if (!updated.rows[0]) {
          const current = await client.query(
            `SELECT version FROM buddy_streaks WHERE id = $1 AND deleted_at IS NULL`,
            [id],
          )
          return {
            status: 'conflict',
            version: current.rows[0]?.version || version,
          }
        }
        await notifyActiveBuddyMembers(client, {
          buddyStreakId: id,
          actorUserId: req.userId,
          eventType: 'edited',
          deduplicationKey: `buddy:${id}:edited:${updated.rows[0].version}`,
        })
        return { status: 'updated' }
      })
      if (result.status === 'missing') {
        return res.status(404).json({ error: 'Buddy streak not found.' })
      }
      if (result.status === 'forbidden') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      if (result.status === 'conflict') {
        return sendConflict(res, result.version)
      }
      return res.json(await loadBuddy(poolFn, id, req.userId))
    } catch (error) {
      console.error('update buddy streak error', error)
      return res.status(500).json({ error: 'Could not update buddy streak.' })
    }
  })

  router.delete('/:id', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    const version = parseVersion(req.body?.version)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    if (!version) return res.status(400).json({ error: 'Version is required.' })
    try {
      const result = await transaction(poolFn, async (client) => {
        const membership = await activeMembership(client, id, req.userId, true)
        if (!membership) return { status: 'missing' }
        if (membership.role !== 'participant') return { status: 'forbidden' }
        const deleted = await client.query(
          `UPDATE buddy_streaks
           SET deleted_at = now(), version = version + 1, updated_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL
           RETURNING version`,
          [id, version],
        )
        if (!deleted.rows[0]) {
          const current = await client.query(
            `SELECT version FROM buddy_streaks WHERE id = $1 AND deleted_at IS NULL`,
            [id],
          )
          return {
            status: 'conflict',
            version: current.rows[0]?.version || version,
          }
        }
        await notifyActiveBuddyMembers(client, {
          buddyStreakId: id,
          actorUserId: req.userId,
          eventType: 'removed',
          deduplicationKey: `buddy:${id}:removed`,
        })
        return { status: 'deleted', version: deleted.rows[0].version }
      })
      if (result.status === 'missing') {
        return res.status(404).json({ error: 'Buddy streak not found.' })
      }
      if (result.status === 'forbidden') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      if (result.status === 'conflict') {
        return sendConflict(res, result.version)
      }
      return res.json({ ok: true, version: result.version })
    } catch (error) {
      console.error('delete buddy streak error', error)
      return res.status(500).json({ error: 'Could not delete buddy streak.' })
    }
  })

  router.put('/:id/completion', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    try {
      const result = await transaction(poolFn, async (client) => {
        const membership = await activeMembership(client, id, req.userId, true)
        if (!membership) return { status: 'missing' }
        if (membership.role !== 'participant') return { status: 'forbidden' }
        const timezone = normalizeIanaTimezone(membership.timezone)
        if (!timezone) return { status: 'timezone' }
        const now = new Date()
        const periodKey = buddyPeriodKey(membership.definition, now, timezone)
        const completionDate = localStreakDate(now, timezone)
        await client.query(
          `INSERT INTO buddy_streak_completions (
             buddy_streak_id, user_id, period_key, completion_date,
             local_completed_at, source
           ) VALUES ($1, $2, $3, $4, $5, 'manual')
           ON CONFLICT (
             buddy_streak_id, user_id, period_key, completion_date
           ) DO UPDATE
           SET local_completed_at = EXCLUDED.local_completed_at,
               completed_at = now(),
               source = EXCLUDED.source`,
          [
            id,
            req.userId,
            periodKey,
            completionDate,
            localTimestamp(now, timezone),
          ],
        )
        await notifyActiveBuddyMembers(client, {
          buddyStreakId: id,
          actorUserId: req.userId,
          eventType: 'completed',
          payload: { periodKey },
          deduplicationKey: `buddy:${id}:completed:${periodKey}:${req.userId}`,
        })
        return { status: 'completed', periodKey }
      })
      if (result.status === 'missing') {
        return res.status(404).json({ error: 'Buddy streak not found.' })
      }
      if (result.status === 'forbidden') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      if (result.status === 'timezone') {
        return res.status(409).json({ error: 'Member timezone is invalid.' })
      }
      await publishBuddyChange(poolFn, id, req.userId, {
        change: 'completion',
        resourceId: id,
        completedUserId: String(req.userId),
        completed: true,
      })
      return res.json({ completed: true, periodKey: result.periodKey })
    } catch (error) {
      console.error('complete buddy streak error', error)
      return res.status(500).json({ error: 'Could not complete buddy streak.' })
    }
  })

  router.delete('/:id/completion', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    try {
      const membership = await activeMembership(poolFn, id, req.userId)
      if (!membership) return res.status(404).json({ error: 'Buddy streak not found.' })
      if (membership.role !== 'participant') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      const timezone = normalizeIanaTimezone(membership.timezone)
      if (!timezone) return res.status(409).json({ error: 'Member timezone is invalid.' })
      const now = new Date()
      const periodKey = buddyPeriodKey(membership.definition, now, timezone)
      const completionDate = localStreakDate(now, timezone)
      await poolFn.query(
        `DELETE FROM buddy_streak_completions
         WHERE buddy_streak_id = $1 AND user_id = $2 AND period_key = $3
           AND completion_date = $4`,
        [id, req.userId, periodKey, completionDate],
      )
      await publishBuddyChange(poolFn, id, req.userId, {
        change: 'completion',
        resourceId: id,
        completedUserId: String(req.userId),
        completed: false,
      })

      return res.json({ completed: false, periodKey })
    } catch (error) {
      console.error('undo buddy streak error', error)
      return res.status(500).json({ error: 'Could not undo buddy streak completion.' })
    }
  })

  router.put('/:id/completions/:dateKey', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    try {
      const membership = await activeMembership(poolFn, id, req.userId)
      if (!membership) return res.status(404).json({ error: 'Buddy streak not found.' })
      if (membership.role !== 'participant') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      const timezone = normalizeIanaTimezone(membership.timezone)
      const periodKey = buddyPeriodKeyForDate(membership.definition, req.params.dateKey)
      const currentDate = timezone ? localCalendarDate(new Date(), timezone) : null
      const createdDate = timezone
        ? localCalendarDate(membership.definition.createdAt, timezone)
        : null
      if (!timezone || !periodKey || req.params.dateKey > currentDate ||
          (createdDate && req.params.dateKey < createdDate)) {
        return res.status(400).json({ error: 'Completion date is invalid.' })
      }
      await poolFn.query(
        `INSERT INTO buddy_streak_completions (
           buddy_streak_id, user_id, period_key, completion_date,
           local_completed_at, source
         ) VALUES ($1, $2, $3, $4, $5, 'manual')
         ON CONFLICT (
           buddy_streak_id, user_id, period_key, completion_date
         ) DO UPDATE
         SET local_completed_at = EXCLUDED.local_completed_at,
             completed_at = now(),
             source = EXCLUDED.source`,
        [
          id,
          req.userId,
          periodKey,
          req.params.dateKey,
          `${req.params.dateKey} 12:00:00`,
        ],
      )
      await publishBuddyChange(poolFn, id, req.userId, {
        change: 'completion',
        resourceId: id,
        completedUserId: String(req.userId),
        completed: true,
      })
      return res.json({ completed: true, periodKey, dateKey: req.params.dateKey })
    } catch (error) {
      console.error('add buddy streak completion date error', error)
      return res.status(500).json({ error: 'Could not add streak completion.' })
    }
  })

  router.delete('/:id/completions/:dateKey', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    if (!id) return res.status(404).json({ error: 'Buddy streak not found.' })
    try {
      const membership = await activeMembership(poolFn, id, req.userId)
      if (!membership) return res.status(404).json({ error: 'Buddy streak not found.' })
      if (membership.role !== 'participant') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      const timezone = normalizeIanaTimezone(membership.timezone)
      const periodKey = buddyPeriodKeyForDate(membership.definition, req.params.dateKey)
      const currentDate = timezone ? localCalendarDate(new Date(), timezone) : null
      const createdDate = timezone
        ? localCalendarDate(membership.definition.createdAt, timezone)
        : null
      if (!timezone || !periodKey || req.params.dateKey > currentDate ||
          (createdDate && req.params.dateKey < createdDate)) {
        return res.status(400).json({ error: 'Completion date is invalid.' })
      }
      await poolFn.query(
        `DELETE FROM buddy_streak_completions
         WHERE buddy_streak_id = $1 AND user_id = $2 AND period_key = $3
           AND completion_date = $4`,
        [id, req.userId, periodKey, req.params.dateKey],
      )
      await publishBuddyChange(poolFn, id, req.userId, {
        change: 'completion',
        resourceId: id,
        completedUserId: String(req.userId),
        completed: false,
      })
      return res.json({ completed: false, periodKey, dateKey: req.params.dateKey })
    } catch (error) {
      console.error('remove buddy streak completion date error', error)
      return res.status(500).json({ error: 'Could not remove streak completion.' })
    }
  })

  router.post('/:id/ping', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    const recipientUserId = parseResourceId(req.body?.recipientUserId)
    if (!id || !recipientUserId) {
      return res.status(400).json({ error: 'A valid recipient is required.' })
    }
    if (String(recipientUserId) === String(req.userId)) {
      return res.status(400).json({ error: 'You cannot ping yourself.' })
    }
    try {
      const result = await transaction(poolFn, async (client) => {
        const sender = await activeMembership(client, id, req.userId, true)
        if (!sender) return { status: 'missing' }
        const recipientResult = await client.query(
          `SELECT member.role, users.timezone, users.username,
                  users.display_username, users.status
           FROM buddy_streak_members member
           JOIN users ON users.id = member.user_id
           WHERE member.buddy_streak_id = $1
             AND member.user_id = $2
             AND member.removed_at IS NULL
           FOR UPDATE OF member`,
          [id, recipientUserId],
        )
        const recipient = recipientResult.rows[0]
        if (!recipient || recipient.role !== 'participant' ||
            recipient.status !== 'active') {
          return { status: 'recipient' }
        }
        const timezone = normalizeIanaTimezone(recipient.timezone)
        if (!timezone) return { status: 'timezone' }
        const periodKey = buddyPeriodKey(sender.definition, new Date(), timezone)
        const completion = await client.query(
          `SELECT count(DISTINCT completion_date)::integer AS completion_count
           FROM buddy_streak_completions
           WHERE buddy_streak_id = $1 AND user_id = $2 AND period_key = $3`,
          [id, recipientUserId, periodKey],
        )
        const target = buddyCompletionTarget(sender.definition, periodKey)
        if (Number(completion.rows[0]?.completion_count) >= target) {
          return { status: 'completed' }
        }
        const lockKey = `buddy:${id}:sender:${req.userId}:recipient:${recipientUserId}`
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          lockKey,
        ])
        const rate = await client.query(
          `SELECT count(*)::integer AS ping_count,
                  GREATEST(
                    1,
                    CEIL(EXTRACT(EPOCH FROM (
                      min(sent_at) + interval '1 hour' - now()
                    )))
                  )::integer AS retry_after
           FROM ping_rate_limits
           WHERE sender_user_id = $1
             AND recipient_user_id = $2
             AND resource_type = 'buddy_streak'
             AND resource_id = $3
             AND sent_at > now() - interval '1 hour'`,
          [req.userId, recipientUserId, id],
        )
        if (Number(rate.rows[0]?.ping_count) >= 3) {
          return {
            status: 'limited',
            retryAfter: Number(rate.rows[0]?.retry_after) || 3600,
          }
        }
        const actor = await client.query(
          `SELECT username, display_username FROM users
           WHERE id = $1 AND status = 'active'`,
          [req.userId],
        )
        if (!actor.rows[0]) return { status: 'missing' }
        await client.query(
          `INSERT INTO ping_rate_limits (
             sender_user_id, recipient_user_id, resource_type, resource_id
           ) VALUES ($1, $2, 'buddy_streak', $3)`,
          [req.userId, recipientUserId, id],
        )
        const event = await insertCollaborationEvent(client, {
          resourceType: 'buddy_streak',
          resourceId: id,
          actorUserId: req.userId,
          recipientUserId,
          eventType: 'ping',
          payload: {
            actorDisplayUsername:
              actor.rows[0].display_username || actor.rows[0].username,
            nudgeNumber: Number(rate.rows[0]?.ping_count) + 1,
          },
          requestPush: true,
        })
        return {
          status: 'sent',
          eventId: event.rows[0]?.id,
          nudgeNumber: Number(rate.rows[0]?.ping_count) + 1,
        }
      })
      if (result.status === 'missing') {
        return res.status(404).json({ error: 'Buddy streak not found.' })
      }
      if (result.status === 'recipient') {
        return res.status(404).json({ error: 'Active participant not found.' })
      }
      if (result.status === 'timezone') {
        return res.status(409).json({ error: 'Recipient timezone is invalid.' })
      }
      if (result.status === 'completed') {
        return res.status(409).json({ error: 'This participant already completed the streak.' })
      }
      if (result.status === 'limited') {
        res.set('Retry-After', String(result.retryAfter))
        return res.status(429).json({ error: 'Ping limit reached. Try again later.' })
      }
      return res.status(201).json({
        ok: true,
        eventId: result.eventId ? String(result.eventId) : null,
        nudgeNumber: result.nudgeNumber,
      })
    } catch (error) {
      console.error('ping buddy streak member error', error)
      return res.status(500).json({ error: 'Could not send buddy ping.' })
    }
  })

  router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    const targetUserId = parseResourceId(req.params.userId)
    const version = parseVersion(req.body?.version)
    if (!id || !targetUserId) {
      return res.status(404).json({ error: 'Buddy streak member not found.' })
    }
    if (!version) return res.status(400).json({ error: 'Version is required.' })
    try {
      const result = await transaction(poolFn, async (client) => {
        const membership = await activeMembership(client, id, req.userId, true)
        if (!membership) return { status: 'missing' }
        const removingSelf = String(targetUserId) === String(req.userId)
        if (!removingSelf && membership.role !== 'participant') {
          return { status: 'forbidden' }
        }
        const target = await client.query(
          `SELECT user_id FROM buddy_streak_members
           WHERE buddy_streak_id = $1 AND user_id = $2 AND removed_at IS NULL
           FOR UPDATE`,
          [id, targetUserId],
        )
        if (!target.rows[0]) return { status: 'member-missing' }
        const updated = await client.query(
          `UPDATE buddy_streaks
           SET version = version + 1, updated_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL
           RETURNING version`,
          [id, version],
        )
        if (!updated.rows[0]) {
          const current = await client.query(
            `SELECT version FROM buddy_streaks WHERE id = $1 AND deleted_at IS NULL`,
            [id],
          )
          return {
            status: 'conflict',
            version: current.rows[0]?.version || version,
          }
        }
        await client.query(
          `UPDATE buddy_streak_members
           SET removed_at = now()
           WHERE buddy_streak_id = $1 AND user_id = $2 AND removed_at IS NULL`,
          [id, targetUserId],
        )
        await insertCollaborationEvent(client, {
          resourceType: 'buddy_streak',
          resourceId: id,
          actorUserId: req.userId,
          recipientUserId: targetUserId,
          eventType: 'removed',
          deduplicationKey: `buddy:${id}:member:${targetUserId}:removed:${updated.rows[0].version}`,
        })

        return { status: 'removed', version: updated.rows[0].version }
      })
      if (result.status === 'missing' || result.status === 'member-missing') {
        return res.status(404).json({ error: 'Buddy streak member not found.' })
      }
      if (result.status === 'forbidden') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      if (result.status === 'conflict') return sendConflict(res, result.version)
      return res.json({
        ok: true,
        removedUserId: targetUserId,
        version: result.version,
      })
    } catch (error) {
      console.error('remove buddy streak member error', error)
      return res.status(500).json({ error: 'Could not remove buddy streak member.' })
    }
  })

  router.patch('/:id/members/:userId', requireAuth, async (req, res) => {
    const id = parseResourceId(req.params.id)
    const targetUserId = parseResourceId(req.params.userId)
    const version = parseVersion(req.body?.version)
    const role = req.body?.role
    if (!id || !targetUserId) {
      return res.status(404).json({ error: 'Buddy streak member not found.' })
    }
    if (!version || !['participant', 'observer'].includes(role)) {
      return res.status(400).json({ error: 'Role and version are required.' })
    }
    try {
      const result = await transaction(poolFn, async (client) => {
        const membership = await activeMembership(client, id, req.userId, true)
        if (!membership) return { status: 'missing' }
        if (membership.role !== 'participant') return { status: 'forbidden' }
        const target = await client.query(
          `SELECT role FROM buddy_streak_members
           WHERE buddy_streak_id = $1 AND user_id = $2 AND removed_at IS NULL
           FOR UPDATE`,
          [id, targetUserId],
        )
        if (!target.rows[0]) return { status: 'member-missing' }
        if (String(targetUserId) === String(req.userId)) return { status: 'self' }
        const updated = await client.query(
          `UPDATE buddy_streaks
           SET version = version + 1, updated_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL
           RETURNING version`,
          [id, version],
        )
        if (!updated.rows[0]) {
          const current = await client.query(
            `SELECT version FROM buddy_streaks WHERE id = $1 AND deleted_at IS NULL`,
            [id],
          )
          return { status: 'conflict', version: current.rows[0]?.version || version }
        }
        await client.query(
          `UPDATE buddy_streak_members
           SET role = $3, active_at = now()
           WHERE buddy_streak_id = $1 AND user_id = $2 AND removed_at IS NULL`,
          [id, targetUserId, role],
        )
        return { status: 'updated' }
      })
      if (['missing', 'member-missing'].includes(result.status)) {
        return res.status(404).json({ error: 'Buddy streak member not found.' })
      }
      if (result.status === 'forbidden') {
        return res.status(403).json({ error: 'Participant access required.' })
      }
      if (result.status === 'self') {
        return res.status(400).json({ error: 'You cannot change your own access.' })
      }
      if (result.status === 'conflict') return sendConflict(res, result.version)
      return res.json(await loadBuddy(poolFn, id, req.userId))
    } catch (error) {
      console.error('update buddy streak member error', error)
      return res.status(500).json({ error: 'Could not update member access.' })
    }
  })

  return router
}

export default createBuddyStreaksRouter()
