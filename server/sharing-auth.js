const RESOURCE_TYPES = new Set(['buddy_streak', 'medication_list'])

export function parseResourceType(value) {
  return RESOURCE_TYPES.has(value) ? value : null
}

export function parseResourceId(value) {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' && /^[1-9]\d{0,18}$/.test(text) ? text : null
}

export function validatePermissions(resourceType, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()

  if (resourceType === 'buddy_streak') {
    if (keys.join(',') !== 'role') return null
    if (!['participant', 'observer'].includes(value.role)) return null
    return { role: value.role }
  }

  if (resourceType === 'medication_list') {
    if (keys.join(',') !== 'canViewHistory,role') return null
    if (!['viewer', 'editor'].includes(value.role)) return null
    if (typeof value.canViewHistory !== 'boolean') return null
    return {
      role: value.role,
      can_view_history: value.canViewHistory,
    }
  }

  return null
}

export async function canInviteResource(client, resourceType, resourceId, userId) {
  let sql
  if (resourceType === 'buddy_streak') {
    sql = `SELECT streak.id
       FROM buddy_streaks streak
       JOIN buddy_streak_members member
         ON member.buddy_streak_id = streak.id
        AND member.user_id = $2
        AND member.role = 'participant'
        AND member.removed_at IS NULL
       WHERE streak.id = $1 AND streak.deleted_at IS NULL`
  } else if (resourceType === 'medication_list') {
    sql = `SELECT owner_user_id
       FROM medication_lists
       WHERE owner_user_id = $1 AND owner_user_id = $2`
  } else return false
  const result = await client.query(sql, [resourceId, userId])
  return Boolean(result.rows[0])
}

export async function grantInviteAccess(client, invite, userId) {
  if (invite.resource_type === 'buddy_streak') {
    const timezone = await client.query(
      `SELECT timezone FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    )
    if (!timezone.rows[0]) return false
    await client.query(
      `INSERT INTO buddy_streak_members (
         buddy_streak_id, user_id, role, timezone
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (buddy_streak_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           timezone = EXCLUDED.timezone,
           active_at = now(),
           removed_at = NULL`,
      [
        invite.resource_id,
        userId,
        invite.permission_payload.role,
        timezone.rows[0].timezone,
      ],
    )
    return true
  }

  if (invite.resource_type === 'medication_list') {
    await client.query(
      `INSERT INTO medication_list_shares (
         owner_user_id, grantee_user_id, role, can_view_history, created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_user_id, grantee_user_id) DO UPDATE
       SET role = EXCLUDED.role,
           can_view_history = EXCLUDED.can_view_history,
           created_by_user_id = EXCLUDED.created_by_user_id,
           revoked_at = NULL`,
      [
        invite.resource_id,
        userId,
        invite.permission_payload.role,
        invite.permission_payload.can_view_history,
        invite.invited_by_user_id,
      ],
    )
    await client.query(
      `UPDATE medication_lists
       SET version = version + 1, updated_at = now()
       WHERE owner_user_id = $1`,
      [invite.resource_id],
    )
    return true
  }

  return false
}
