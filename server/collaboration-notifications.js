import {
  buddyPeriodKey,
  isBuddyOccurrenceScheduled,
  isEffectiveParticipant,
  normalizeIanaTimezone,
  occurrenceCompletion,
  zonedParts,
} from './buddy-core.js'
import { insertCollaborationEvent } from './collaboration-events.js'

export function buddyReminderPhase(instant, timezone) {
  const validTimezone = normalizeIanaTimezone(timezone)
  if (!validTimezone) return null
  const { hour, minute } = zonedParts(instant, validTimezone)
  if (minute !== 0) return null
  if (hour === 17) return 'afternoon'
  if (hour === 22) return 'evening'
  return null
}

export function reminderBody(names) {
  const safeNames = names.filter(Boolean)
  if (!safeNames.length) return 'Your Chrona buddies still have an incomplete streak.'
  if (safeNames.length === 1) return `${safeNames[0]} still has an incomplete streak.`
  return `${safeNames.slice(0, -1).join(', ')} and ${safeNames.at(-1)} still have incomplete streaks.`
}

export function collaborationPushPayload(event) {
  const payload = typeof event.payload === 'string'
    ? JSON.parse(event.payload)
    : (event.payload || {})
  const isPing = event.event_type === 'ping'
  const actor = payload.actorDisplayUsername || 'A Chrona buddy'
  const nudgeCopy = payload.nudgeNumber === 3
    ? `${actor} is aggressively nudging you to complete your streak.`
    : payload.nudgeNumber === 2
      ? `${actor} is nudging you again to complete your streak.`
      : `${actor} is nudging you to complete your streak.`
  const body = isPing
    ? nudgeCopy
    : reminderBody(payload.incompleteDisplayUsernames || [])
  return {
    title: 'Chrona buddy',
    body,
    tag: isPing
      ? `buddy-${event.resource_id}-ping-${event.id}`
      : `buddy-${event.resource_id}-${payload.periodKey}-${payload.phase}`,
    url: `/?buddyStreak=${encodeURIComponent(event.resource_id)}`,
  }
}

export async function queueAutomaticBuddyReminders(queryFn, instant = new Date()) {
  const candidates = (await queryFn(
    `SELECT streak.id AS buddy_streak_id, streak.definition,
            recipient.user_id AS recipient_user_id, users.timezone
     FROM buddy_streaks streak
     JOIN buddy_streak_members recipient ON recipient.buddy_streak_id = streak.id
     JOIN users ON users.id = recipient.user_id
     WHERE streak.deleted_at IS NULL
       AND recipient.removed_at IS NULL
       AND users.status = 'active'`,
  )).rows
  let queued = 0
  const streakData = new Map()
  for (const candidate of candidates) {
    const phase = buddyReminderPhase(instant, candidate.timezone)
    if (!phase) continue
    const periodKey = buddyPeriodKey(
      candidate.definition,
      instant,
      candidate.timezone,
    )
    if (!isBuddyOccurrenceScheduled(candidate.definition, periodKey)) continue
    const streakId = String(candidate.buddy_streak_id)
    let data = streakData.get(streakId)
    if (!data) {
      const [members, completions] = await Promise.all([
        queryFn(
          `SELECT member.user_id, member.role, member.timezone, member.active_at,
                  member.removed_at, users.username, users.display_username
           FROM buddy_streak_members member
           JOIN users ON users.id = member.user_id
           WHERE member.buddy_streak_id = $1`,
          [streakId],
        ),
        queryFn(
          `SELECT user_id, period_key, completion_date
           FROM buddy_streak_completions
           WHERE buddy_streak_id = $1 AND period_key = $2`,
          [streakId, periodKey],
        ),
      ])
      data = { members: members.rows, completionsByPeriod: new Map() }
      data.completionsByPeriod.set(periodKey, completions.rows)
      streakData.set(streakId, data)
    } else if (!data.completionsByPeriod.has(periodKey)) {
      const completions = await queryFn(
        `SELECT user_id, period_key, completion_date
         FROM buddy_streak_completions
         WHERE buddy_streak_id = $1 AND period_key = $2`,
        [streakId, periodKey],
      )
      data.completionsByPeriod.set(periodKey, completions.rows)
    }
    const completed = new Set(occurrenceCompletion(
      periodKey,
      data.members,
      data.completionsByPeriod.get(periodKey),
      candidate.definition,
    ).completedParticipantIds)
    const incompleteNames = data.members
      .filter((member) => isEffectiveParticipant(member, periodKey))
      .filter((member) => !completed.has(String(member.user_id)))
      .map((member) => member.display_username || member.username)
    if (!incompleteNames.length) continue
    const result = await insertCollaborationEvent({ query: queryFn }, {
      resourceType: 'buddy_streak',
      resourceId: streakId,
      actorUserId: null,
      recipientUserId: candidate.recipient_user_id,
      eventType: 'automatic_reminder',
      payload: {
        periodKey,
        phase,
        incompleteDisplayUsernames: incompleteNames,
      },
      deduplicationKey:
        `buddy:${streakId}:recipient:${candidate.recipient_user_id}:` +
        `period:${periodKey}:phase:${phase}`,
      requestPush: true,
    })
    queued += result.rowCount || 0
  }
  return queued
}

export async function dispatchCollaborationPushes({
  queryFn,
  sendNotification,
  instant = new Date(),
  limit = 100,
}) {
  const events = (await queryFn(
    `WITH pending AS (
       SELECT id
       FROM collaboration_events
       WHERE push_requested_at IS NOT NULL
         AND push_dispatched_at IS NULL
         AND (push_claimed_at IS NULL OR push_claimed_at < $1::timestamptz - interval '10 minutes')
       ORDER BY id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE collaboration_events event
     SET push_claimed_at = $1
     FROM pending
     WHERE event.id = pending.id
     RETURNING event.id, event.resource_id, event.event_type, event.payload`,
    [instant, limit],
  )).rows
  let dispatched = 0
  for (const event of events) {
    const subscriptions = (await queryFn(
      `SELECT endpoint, subscription
       FROM push_subscriptions
       WHERE user_id = (
         SELECT recipient_user_id FROM collaboration_events WHERE id = $1
       )`,
      [event.id],
    )).rows
    let retry = false
    const pushPayload = JSON.stringify(collaborationPushPayload(event))
    for (const subscription of subscriptions) {
      try {
        await sendNotification(subscription.subscription, pushPayload)
      } catch (error) {
        if ([403, 404, 410].includes(error?.statusCode)) {
          await queryFn(
            'DELETE FROM push_subscriptions WHERE endpoint = $1',
            [subscription.endpoint],
          ).catch(() => {})
        } else {
          retry = true
        }
      }
    }
    await queryFn(
      retry
        ? `UPDATE collaboration_events SET push_claimed_at = NULL WHERE id = $1`
        : `UPDATE collaboration_events
           SET push_dispatched_at = $2, push_claimed_at = NULL
           WHERE id = $1`,
      retry ? [event.id] : [event.id, instant],
    )
    if (!retry) dispatched++
  }
  return dispatched
}
