const DAY_MS = 86_400_000
export const BUDDY_GRACE_MINUTES = 30

function dateFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

function dateKey(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(key, amount) {
  const date = dateFromKey(key)
  return date ? dateKey(new Date(date.getTime() + amount * DAY_MS)) : null
}

export function normalizeIanaTimezone(value) {
  if (typeof value !== 'string' || value.length > 100) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
      .timeZone
  } catch {
    return null
  }
}

export function zonedParts(instant = new Date(), timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeIanaTimezone(timezone) || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  return Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [
      type,
      Number(value),
    ]),
  )
}

export function localStreakDate(instant = new Date(), timezone = 'UTC') {
  const parts = zonedParts(instant, timezone)
  let key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  if (parts.hour === 0 && parts.minute <= BUDDY_GRACE_MINUTES) key = addDays(key, -1)
  return key
}

export function buddyPeriodKind(definition) {
  return definition?.schedule?.mode === 'weekly' ? 'week' : 'day'
}

export function buddyPeriodKey(
  definition,
  instant = new Date(),
  timezone = 'UTC',
) {
  let localDate = localStreakDate(instant, timezone)
  const createdDate = localCalendarDate(definition?.createdAt, timezone)
  if (createdDate && createdDate > localDate) localDate = createdDate
  if (buddyPeriodKind(definition) === 'day') return `day:${localDate}`
  const date = dateFromKey(localDate)
  return `week:${addDays(localDate, -date.getUTCDay())}`
}

export function buddyPeriodKeyForDate(definition, localDate) {
  const date = dateFromKey(localDate)
  if (!date || dateKey(date) !== localDate) return null
  if (buddyPeriodKind(definition) === 'day') return `day:${localDate}`
  return `week:${addDays(localDate, -date.getUTCDay())}`
}

export function periodBounds(periodKey) {
  const match = /^(day|week):(\d{4}-\d{2}-\d{2})$/.exec(periodKey)
  if (!match || !dateFromKey(match[2])) return null
  return {
    kind: match[1],
    start: match[2],
    end: addDays(match[2], match[1] === 'week' ? 6 : 0),
  }
}

export function localCalendarDate(instant, timezone) {
  if (!instant) return null
  const parts = zonedParts(instant, timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function membershipDates(member) {
  const timezone = normalizeIanaTimezone(member.timezone) || 'UTC'
  return {
    effectiveFrom: localCalendarDate(member.activeAt || member.active_at, timezone),
    effectiveTo: localCalendarDate(member.removedAt || member.removed_at, timezone),
  }
}

export function isEffectiveParticipant(member, periodKey) {
  if (member.role !== 'participant') return false
  const bounds = periodBounds(periodKey)
  if (!bounds) return false
  const { effectiveFrom, effectiveTo } = membershipDates(member)
  return (!effectiveFrom || effectiveFrom <= bounds.end) &&
    (!effectiveTo || effectiveTo > bounds.start)
}

export function occurrenceCompletion(periodKey, members, completions) {
  const participantIds = members
    .filter((member) => isEffectiveParticipant(member, periodKey))
    .map((member) => String(member.userId ?? member.user_id))
  const completedIds = new Set(
    completions
      .filter((completion) => completion.periodKey === periodKey ||
        completion.period_key === periodKey)
      .map((completion) => String(completion.userId ?? completion.user_id)),
  )
  return {
    periodKey,
    participantIds,
    completedParticipantIds: participantIds.filter((id) => completedIds.has(id)),
    complete: participantIds.length > 0 &&
      participantIds.every((id) => completedIds.has(id)),
  }
}

function previousPeriodKey(periodKey) {
  const bounds = periodBounds(periodKey)
  if (!bounds) return null
  return `${bounds.kind}:${addDays(bounds.start, bounds.kind === 'week' ? -7 : -1)}`
}

function isScheduledDaily(definition, key) {
  const date = dateFromKey(key)
  if (!date) return false
  const raw = definition?.schedule
  const schedule = Array.isArray(raw)
    ? { freq: 'weekly', interval: 1, days: raw }
    : (raw || {})
  if (schedule.mode === 'weekly') return true
  const frequency = schedule.freq || 'weekly'
  const interval = Math.max(1, Number(schedule.interval) || 1)
  const anchorKey = schedule.anchor ||
    String(definition?.createdAt || new Date().toISOString()).slice(0, 10)
  const anchor = dateFromKey(anchorKey) || date
  if (frequency === 'weekly') {
    const days = Array.isArray(schedule.days) && schedule.days.length
      ? schedule.days
      : [0, 1, 2, 3, 4, 5, 6]
    if (!days.includes(date.getUTCDay())) return false
    const start = new Date(date.getTime() - date.getUTCDay() * DAY_MS)
    const anchorStart = new Date(anchor.getTime() - anchor.getUTCDay() * DAY_MS)
    return Math.round((start - anchorStart) / (7 * DAY_MS)) % interval === 0
  }

  if (frequency === 'monthly') {
    const target = Math.min(
      Number(schedule.dayOfMonth) || anchor.getUTCDate(),
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
        .getUTCDate(),
    )
    const months = (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      date.getUTCMonth() - anchor.getUTCMonth()
    return date.getUTCDate() === target && months % interval === 0
  }
  if (frequency === 'yearly') {
    return date.getUTCMonth() === anchor.getUTCMonth() &&
      date.getUTCDate() === anchor.getUTCDate() &&
      (date.getUTCFullYear() - anchor.getUTCFullYear()) % interval === 0
  }
  return true
}

export function isBuddyOccurrenceScheduled(definition, periodKey) {
  const bounds = periodBounds(periodKey)
  if (!bounds) return false
  return bounds.kind === 'week' || isScheduledDaily(definition, bounds.start)
}

function previousOccurrenceKey(definition, periodKey) {
  let key = previousPeriodKey(periodKey)
  if (buddyPeriodKind(definition) === 'week') return key
  for (let i = 0; key && i < 3650; i++) {
    const bounds = periodBounds(key)
    if (isScheduledDaily(definition, bounds.start)) return key
    key = previousPeriodKey(key)
  }
  return key
}

export function computeGroupStreak(
  definition,
  members,
  completions,
  instant = new Date(),
  timezone = 'UTC',
) {
  let key = buddyPeriodKey(definition, instant, timezone)
  let summary = occurrenceCompletion(key, members, completions)
  let streak = 0
  if (summary.complete) {
    streak++
    key = previousOccurrenceKey(definition, key)
  }
  else key = previousOccurrenceKey(definition, key)
  for (let i = 0; key && i < 3650; i++) {
    summary = occurrenceCompletion(key, members, completions)
    if (!summary.complete) break
    streak++
    key = previousOccurrenceKey(definition, key)
  }
  return streak
}

export function sanitizeBuddyDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return null
  }
  if (serialized.length > 100_000) return null
  const definition = JSON.parse(serialized)
  delete definition.id
  delete definition.completions
  delete definition.freezes
  if (definition.name !== undefined &&
      (typeof definition.name !== 'string' || definition.name.length > 200)) {
    return null
  }
  return definition
}

export function privateCompletionPeriodKeys(set) {
  const definition = sanitizeBuddyDefinition(set)
  if (!definition) return []
  return Object.entries(set?.completions || {})
    .filter(([key, completed]) => completed && dateFromKey(key))
    .map(([key]) => buddyPeriodKind(definition) === 'week'
      ? `week:${addDays(key, -dateFromKey(key).getUTCDay())}`
      : `day:${key}`)
    .filter((key, index, keys) => keys.indexOf(key) === index)
}
