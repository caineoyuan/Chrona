const EVENT_TYPES = new Set([
  'invite',
  'accepted',
  'completed',
  'ping',
  'edited',
  'removed',
  'automatic_reminder',
])

export function minimalEventPayload(eventType, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  if (eventType === 'invite' || eventType === 'accepted') {
    return value.inviteId === undefined ? {} : { inviteId: String(value.inviteId) }
  }
  if (eventType === 'completed') {
    return typeof value.periodKey === 'string'
      ? { periodKey: value.periodKey.slice(0, 32) }
      : {}
  }
  if (eventType === 'ping') {
    const result = {}
    if (typeof value.actorDisplayUsername === 'string') {
      result.actorDisplayUsername = value.actorDisplayUsername.slice(0, 100)
    }
    if ([1, 2, 3].includes(value.nudgeNumber)) result.nudgeNumber = value.nudgeNumber
    return result
  }
  if (eventType === 'automatic_reminder') {
    const result = {}
    if (typeof value.periodKey === 'string') result.periodKey = value.periodKey.slice(0, 32)
    if (['afternoon', 'evening'].includes(value.phase)) result.phase = value.phase
    if (Array.isArray(value.incompleteDisplayUsernames)) {
      result.incompleteDisplayUsernames = value.incompleteDisplayUsernames
        .filter((name) => typeof name === 'string')
        .slice(0, 20)
        .map((name) => name.slice(0, 100))
    }
    return result
  }
  return {}
}

export async function insertCollaborationEvent(
  client,
  {
    resourceType,
    resourceId,
    actorUserId,
    recipientUserId,
    eventType,
    payload = {},
    deduplicationKey = null,
    requestPush = false,
  },
) {
  if (!EVENT_TYPES.has(eventType)) throw new Error('Unsupported collaboration event')
  return client.query(
    `INSERT INTO collaboration_events (
       resource_type, resource_id, actor_user_id, recipient_user_id,
       event_type, payload, deduplication_key, push_requested_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8::boolean THEN now() ELSE NULL END)
     ON CONFLICT (recipient_user_id, deduplication_key)
       WHERE deduplication_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      resourceType,
      resourceId,
      actorUserId,
      recipientUserId,
      eventType,
      JSON.stringify(minimalEventPayload(eventType, payload)),
      deduplicationKey,
      requestPush,
    ],
  )
}

export async function notifyActiveBuddyMembers(
  client,
  {
    buddyStreakId,
    actorUserId,
    eventType,
    payload = {},
    deduplicationKey = null,
  },
) {
  if (!EVENT_TYPES.has(eventType)) throw new Error('Unsupported collaboration event')
  return client.query(
    `INSERT INTO collaboration_events (
       resource_type, resource_id, actor_user_id, recipient_user_id,
       event_type, payload, deduplication_key
     )
     SELECT 'buddy_streak', $1, $2, member.user_id, $3, $4,
            CASE WHEN $5::text IS NULL THEN NULL
                 ELSE $5 || ':recipient:' || member.user_id::text END
     FROM buddy_streak_members member
     WHERE member.buddy_streak_id = $1
       AND member.removed_at IS NULL
       AND member.user_id <> $2
     ON CONFLICT (recipient_user_id, deduplication_key)
       WHERE deduplication_key IS NOT NULL
     DO NOTHING`,
    [
      buddyStreakId,
      actorUserId,
      eventType,
      JSON.stringify(minimalEventPayload(eventType, payload)),
      deduplicationKey,
    ],
  )
}
